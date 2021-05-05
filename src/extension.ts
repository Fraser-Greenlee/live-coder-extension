'use strict';
const util = require('util');
const exec = util.promisify(require('child_process').exec);
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as request from 'request-promise-native';
import * as vscode from 'vscode';

function _failCase() {
	if (vscode.workspace === undefined) {
		vscode.window.showErrorMessage("Must have an open workspace.");
		return true;
	}
	if (vscode.window.activeTextEditor === undefined) {
		vscode.window.showErrorMessage("Must have an active text editor open.");
		return true;
	}
	if (!LiveValuesPanel.isPython(vscode.window.activeTextEditor)) {
		vscode.window.showErrorMessage("Must open a Python file.");
		return true;
	}
	return false;
}

function _newFileCouldHaveLiveValues() {
	return LiveValuesPanel.currentPanel 
		&& vscode.window.activeTextEditor
		&& LiveValuesPanel.isPython(vscode.window.activeTextEditor)
		&& LiveValuesPanel.currentPanel.isNewActiveEditor(vscode.window.activeTextEditor);
}

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.commands.registerCommand('liveValues.start', () => {
			if (_failCase()) {
				failedStartBitly();
				return;
			}
			startedBitly();

			var openCount: number;
			if (context.globalState.get('openCount')) {
				openCount = Number(context.globalState.get('openCount'));
				if (openCount < 5) {
					openCount++;
				}
			} else {
				openCount = 1;
			}
			context.globalState.update('openCount', openCount);

			LiveValuesPanel.createOrShow(context.extensionPath, openCount);
			return;
		})
    );
    
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges(event => {
			if (LiveValuesPanel.currentPanel && Date.now() - LiveValuesPanel.currentPanel.webviewLastScrolled > 50) {
				scrollPanel(event.textEditor);
			}
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            if (_newFileCouldHaveLiveValues()) {
                LiveValuesPanel.currentPanel!.updateWebview(false);
            }
        })
	);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => {
            if (LiveValuesPanel.currentPanel && vscode.window.activeTextEditor) {
                LiveValuesPanel.currentPanel.updateWebview(true);
            }
        })
	);
}

function scrollPanel(textEditor: vscode.TextEditor) {
    const line = getScrollPosition(textEditor);
    if (typeof line === 'number' && LiveValuesPanel.currentPanel) {
        LiveValuesPanel.currentPanel.scrollWebview(line);
    }
}

class LiveValuesPanel {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel: LiveValuesPanel | undefined;
	public failedStart: boolean;

	public static readonly viewType = 'liveValues';
	
	public openCount: number;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];

	private _currentActiveTextEditor: vscode.TextEditor;

	private _serverProcess!: ChildProcess;
	private _pythonPath: string = '';
	private _serverPort: number = 5321;
	private _projectRoot: string = '';
	public testsRelativePath: string = '';
	public testPattern: string = '';
	
	private _testClasses: any;
	private _selectedTestClassIndex: number = -1;
	private _selectedtestMethodIndex: number = -1;

	private _liveValues: any = {};
	private _callIdToFunction: any = {};
	private _selectedFunctionCallIds: any = {};
	private _testOutput: string[] = new Array();
	private _currentTestId: string = "";
	private _testOutputIsClosed: boolean = true;
	public webviewLastScrolled: number = Date.now();

	private static _alreadyHasPanel() {
		return LiveValuesPanel.currentPanel && LiveValuesPanel.currentPanel._panel;
	}

	private static _showPanel(column: number) {
		LiveValuesPanel.currentPanel!._panel.reveal(column);
	}

	private static _createWebviewPanel(column: number, extensionPath: string) {
		return vscode.window.createWebviewPanel(
			LiveValuesPanel.viewType,
			'Live Coder',
			column,
			{
                enableScripts: true,
                // Maintain UI even when in background
                retainContextWhenHidden: true,
				// Restrict the webview to only loading content from our extension's `webview_src` directory.
				localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'webview_src'))]
			}
		);
	}

	public static createOrShow(extensionPath: string, openCount: number) {
		let panelColumn: number = vscode.ViewColumn.Beside;

		if (LiveValuesPanel._alreadyHasPanel()) {
			LiveValuesPanel.currentPanel!.openCount = openCount;
			LiveValuesPanel._showPanel(panelColumn);
			return;
		}
		const webViewPanel = LiveValuesPanel._createWebviewPanel(panelColumn, extensionPath);

		LiveValuesPanel.currentPanel = new LiveValuesPanel(webViewPanel, extensionPath, openCount);
		if (LiveValuesPanel.currentPanel.failedStart) {
			LiveValuesPanel.currentPanel.dispose();
			return;
		}
	}

	public static revive(webViewPanel: vscode.WebviewPanel, extensionPath: string, openCount: number) {
		// TODO check this function is ever called.
		LiveValuesPanel.currentPanel = new LiveValuesPanel(webViewPanel, extensionPath, openCount);
	}

	public static isPython(activeTextEditor: vscode.TextEditor) {
		const fileName: string = activeTextEditor.document.fileName;
		const potentialPy: string = fileName.substr(fileName.length - 3);
		return potentialPy === '.py';
	}

	public isNewActiveEditor(activeEditor: vscode.TextEditor) {
		return activeEditor.document.fileName !== this._currentActiveTextEditor.document.fileName;
	}

	private _getTestSettings(pythonPath: string) {
		this._pythonPath = pythonPath;
		this._projectRoot = vscode.workspace.rootPath!;
		const pyTestArgs = vscode.workspace.getConfiguration('python.testing.unittestArgs');
		let i: number = 0;
		while ( pyTestArgs.has(String(i)) ) {
			let arg: string|undefined = pyTestArgs.get(String(i));
			if (arg && arg[0] !== '-') {
				if (arg.substr(arg.length - 3, 3) === '.py') {
					this.testPattern = arg;
				} else {
					this.testsRelativePath = arg;
				}
			}
			i++;
		}
	}

	private _startingError(message: string) {
		vscode.window.showErrorMessage(message);
		this._stopStart();
	}
	private _stopStart() {
		if (this._serverProcess) {
			this._serverProcess.kill();
		}
		this._panel.dispose();
		this.failedStart = true;
	}

	private _usesUnittests() {
		return vscode.workspace.getConfiguration('python.testing').get('unittestEnabled');
	}

	private _badSettingsError() {
		const pythonPath =  vscode.workspace.getConfiguration('python').get('pythonPath');
		if (!pythonPath) {
			this._startingError('Please select a Python3 interpreter. Do this with the "Python: Select Interpreter" command. Live Coder only works with Python3 unittests.');
			return true;
		}
		if (this._usesUnittests() === false) {
			this._startingError('Please enable unittests in your settings. Do this with the "Python: Configure Tests" command. Live Coder only works with Python3 unittests.');
			return true;
		}
		this._getTestSettings(String(pythonPath));
		if (this._projectRoot === '' || this.testsRelativePath === '' || this.testPattern === '') {
			this._startingError('Please update your settings for "python.testing.unittestArgs". Do this with the "Python: Configure Tests" command. They must include a test folder and test pattern matcher.');
			return true;
		}
		return false;
	}

	private async _installServer() {
		var installPromise = new Promise((resolve, reject) => {
			exec(`${this._pythonPath} -m pip install --upgrade live-coder`, (error: Error, stdout: string, stderr: string) => {
				if (error) {
					reject(stderr);
				} else {
					resolve('');
				}
			});
		});
		var timeoutPromise = new Promise(function(resolve, reject) { 
			setTimeout(resolve, 7000, "Took too long to install/update the server with pip. To run yourself use `pip install -U live-coder`"); 
		});
		return Promise.race([installPromise, timeoutPromise]).then(function(error) {
			if (error) {
				vscode.window.showErrorMessage(String(error));
			}
		});
	}

	private _getLines(text: string) {
		const lines = text.split('\n');
		return '<span>' + lines.join('</span><span>') + '</span>';
	}

	private async _startServer() {
		if (this._serverProcess) {
			return;
		}
		await this._installServer();
		this._serverProcess = spawn(`${this._pythonPath} -m live_coder ${this._serverPort}`, [], {shell: true});
		
		var stdOut = "";
		this._serverProcess.stdout.setEncoding('utf8');
		this._serverProcess.stdout.on('data', function(data) {
			stdOut += data.toString();
		});
		var stdErr = "";
		this._serverProcess.stderr.setEncoding('utf8');
		this._serverProcess.stderr.on('data', function(data) {
			stdErr += data.toString();
		});

		this._serverProcess.on('exit', code => {
			const outLines = this._getLines(stdOut);
			const errLines = this._getLines(stdErr);
			this._errorHTML(
				`<h2>Server stopped unexpectedly. Check nothing is running on port ${this._serverPort}<h2>
				<p>${outLines}</p>
				<p>${errLines}</p>
			`);
		});
		this._serverProcess.on('error', async error => {
			serverFailedBitly();
			const outLines = this._getLines(stdOut);
			const errLines = this._getLines(stdErr);
			this._errorHTML(
				`<h2>Server failed. Check nothing is running on port ${this._serverPort}<h2>
				<p>${outLines}</p>
				<p>${errLines}</p>
			`);
		});
		await this._sleep(2000);// Give the server time to start.
	}

	private _sleep(ms: number){
		return new Promise(resolve => {
			setTimeout(resolve, ms);
		});
	}	

	private _getTestClasses() {
		let testClassesPromise = newProjectSession(this._serverPort, this._projectRoot, this.testsRelativePath, this.testPattern);
		testClassesPromise.then((response) => {
			if (response.type === 'error') {
				this._startingError(response.message);
				return;
			}
			this._testClasses = response.testClasses;
			this.updateWebview(true);
		});
		testClassesPromise.catch(error => {
			this._panel.webview.html = this._errorHTML(
				'<b>Setting up the server.</b> Will take a few seconds.',
			);
		});
	}

	private _scrollToLine(line: number) {
		this.webviewLastScrolled = Date.now();
		const range = new vscode.Range(line, 0, line + 1, 0);
		this._currentActiveTextEditor.revealRange(
			range, vscode.TextEditorRevealType.AtTop
		);
	}

	private _selectNoTestClass() {
		this._selectedTestClassIndex = -1;
		this._selectedtestMethodIndex = -1;
		this._currentTestId = "";
		this._panel.webview.html = this._errorHTML(
			'<b>No Test Class or Test Method Selected</b> Use the dropdown above to see your code run!'
		);
	}

	private _runTestMethod(classIndex: number, methodIndex: number, method: string) {
		this._currentTestId = method;
		let response = this._getLiveValues();
		response.then((liveValuesAndTestOutput) => {
			if (liveValuesAndTestOutput === undefined) {
				this._panel.webview.html = this._errorHTML(
					'<b>Error</b> Got no response from the server, is it running?'
				);
			} else {
				this._selectedTestClassIndex = classIndex;
				this._selectedtestMethodIndex = methodIndex;
				this._panel.webview.html = this._liveValuesHTML(
					liveValuesAndTestOutput[0],
					liveValuesAndTestOutput[1]
				);
			}
		});
	}

	private _handleWebviewMessages() {
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'revealLine':
                    	this._scrollToLine(message.line);
						return;
					case 'clearLiveValues':
						this._selectNoTestClass();
						return;
					case 'runTestMethod':
						this._runTestMethod(message.classIndex, message.methodIndex, message.method);
						return;
					case 'toggleTestOutput':
						this._testOutputIsClosed = this._testOutputIsClosed === false;
					case 'openFunctionCall':
						this._openFunctionCall(message.callId, message.name);
					case 'updateFunctionCallSelection':
						this._updateFunctionCallSelection(message.callId, message.name);
				}
			},
			null,
			this._disposables
		);
	}

	private constructor(webViewPanel: vscode.WebviewPanel, extensionPath: string, openCount: number) {
		this.failedStart = false;
		this._panel = webViewPanel;
		this._extensionPath = extensionPath;
		this._currentActiveTextEditor = vscode.window.activeTextEditor!;
		this.openCount = openCount;

		// Listen for when _panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		if (this._badSettingsError()) {
			return;
		}
		this._startServer().then(() => {
			this._getTestClasses();
			this._handleWebviewMessages();
		});
	}

	public scrollWebview(yPosition: number) {
		this._panel.webview.postMessage({ command: 'editorScroll', scroll: yPosition });
	}

	public dispose() {
		this._testClasses = null;
		LiveValuesPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
	
	private _updateFileAttributes() {
		if (vscode.window.activeTextEditor) {
			this._currentActiveTextEditor = vscode.window.activeTextEditor;
		}
		this._panel.title = `Live Coder: ` + this._currentFileNameShort();
	}

	private _updatePanelDisplay(reloadValues: boolean) {
		let response;
		if (reloadValues) {
			response = this._getLiveValues();
		} else {
			response = new Promise((resolve, reject) => {
				resolve(this._getLiveValuesForCurrentEditor());
			});
		}
		response.then((liveValuesAndTestOutput: any) => {
			if (liveValuesAndTestOutput === undefined) {
				this._panel.webview.html = this._errorHTML('<b>Error</b> Got no response from the server, is it running?');
			} else {
				this._panel.webview.html = this._liveValuesHTML(
					liveValuesAndTestOutput[0],
					liveValuesAndTestOutput[1]
				);
			}
			scrollPanel(this._currentActiveTextEditor);
		});
	}

	public updateWebview(reloadValues: boolean) {
		updateWebViewBitly();
		this._updateFileAttributes();
		this._updatePanelDisplay(reloadValues);
	}

	private _liveValuesHTML(liveValues: string, testOutput: string) {

		const testClassOptions: string = this._getTestClassOptions();
		const testMethodOptions: string = this._getTestMethodOptions();

		return this._newHTMLdoc(`
			<div id="header">
				<select class="picker" id="testClassPicker">
					<option value="">No Test Class</option>
					<option value="─────────" disabled="">─────────</option>
					${testClassOptions}
				</select>
				<select class="picker" id="testMethodPicker">
					${testMethodOptions}
				</select>
				<a id="issueLink" href="https://gitlab.com/Fraser-Greenlee/live-coder-vscode-extension/issues/new">report an issue</a>
			</div>
			<div id="scrollableLiveValues">
				${liveValues}
				<div id="tooltipBackground"></div>
			</div>
			${testOutput}`
		);
	}

	private _errorHTML(message: string) {
		return this._newHTMLdoc(`
			<div id="scrollableLiveValues">
				<div class="centre"><span>
					${message}
				</span></div>
			</div>
		`);
	}

	private _newHTMLdoc(body: string) {
		// Local path to main script run in the webview
		const scriptPathOnDisk = vscode.Uri.file(
			path.join(this._extensionPath, 'webview_src', 'main.js')
		);

		// And the uri we use to load this script in the webview
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });

		// do above for main.css
		const cssPathOnDisk = vscode.Uri.file(
			path.join(this._extensionPath, 'webview_src', 'main.css')
		);
		const cssUri = cssPathOnDisk.with({ scheme: 'vscode-resource' });

		// Use a nonce to whitelist which scripts can be run
        const nonce = getNonce();

		return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">

                <!--
                Use a content security policy to only allow loading scripts that have a specific nonce.

				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src vscode-resource:; style-src 'unsafe-inline' vscode-resource:;">
				-->

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" nonce="${nonce}" href="${cssUri}">

                <title>Live Coder</title>
            </head>
			<body style="margin-top: 5px;">
				${body}
				<div class="highlight" id="tooltip"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
	}

	private _testClassNameFromId(testClassId: string) {
		const idParts: string[] = testClassId.split('.');
		return idParts[idParts.length - 1];
	}

	private _testFileNameFromId(testClassId: string) {
		const idParts: string[] = testClassId.split('.');
		return idParts.slice(1, idParts.length - 1).join('/') + '.py';
	}

	private _testClassNames() {
		let names: string[] = new Array(this._testClasses.length);
		for (let i = 0; i < this._testClasses.length; i++) {
			const testClass = this._testClasses[i];
			names[i] = this._testClassNameFromId(testClass.id);
		}
		return this._handleDuplicateClassNames(names);
	}

	private _appendFilePathToDuplicateTestClassNames(names: string[], duplicateIndices: number[]) {
		for (let i = 0; i < duplicateIndices.length; i++) {
			const classIndex: number = duplicateIndices[i];
			const testClass = this._testClasses[i];
			names[classIndex] = `${this._testClassNameFromId(testClass.id)} ---- ${this._testFileNameFromId(testClass.id)}`;
		}
		return names;
	}

	private _handleDuplicateClassNames(names: string[]) {
		let duplicateNameToIndices: Map<string, number[]> = getDuplicates(names);
		if (duplicateNameToIndices.size > 0) {
			const duplicateNames: string[] = Array.from(duplicateNameToIndices.keys());
			for (let i = 0; i < duplicateNames.length; i++) {
				const duplicateName: string = duplicateNames[i];
				const duplicateIndices: number[] = duplicateNameToIndices.get(duplicateName)!;
				names = this._appendFilePathToDuplicateTestClassNames(names, duplicateIndices);
			}
		}
		return names;
	}

	private _selectedProperty(selectedIndex: number, i: number) {
		if (i === selectedIndex) {
			return 'selected';
		} else {
			return '';
		}
	}

	private _testClassOption(ClassNames: string[], ClassIndex: number) {
		const name = ClassNames[ClassIndex];
		const testClass = this._testClasses[ClassIndex];
		const selected = this._selectedProperty(this._selectedTestClassIndex, ClassIndex);
		return `<option value="${testClass.id}" data-method_names="${testClass.method_names}" data-method_ids="${testClass.method_ids}" ${selected}>${name}</option>`;
	}

	private _getTestClassOptions() {
		let classNames: string[] = this._testClassNames();
		let options: string[] = new Array(this._testClasses.length);
		for (let i = 0; i < classNames.length; i++) {
			options[i] = this._testClassOption(classNames, i);
		}
		return options.join('');
	}

	private _getTestMethodOptions() {
		if (this._selectedTestClassIndex === -1) {
			return '<option value="">No Test Method</option>';
		} else {
			return this._testMethodOptionsForClass(this._testClasses[this._selectedTestClassIndex]);
		}
	}

	private _testMethodOptionsForClass(testClass: any) {
		let options: string[] = new Array(testClass.method_names.length);
		for (let i = 0; i < testClass.method_names.length; i++) {
			const selected = this._selectedProperty(this._selectedtestMethodIndex, i);
			options[i] = `<option value="${testClass.method_ids[i]}" ${selected}>${testClass.method_names[i]}</option>`;
		}
		return options.join('');
	}

	private _callIdsForFile(filePath: string) {
		const selectedCallIds = this._selectedFunctionCallIds[filePath];
		if (selectedCallIds === undefined) {
			return {};
		}
		return selectedCallIds;
	}

	private _validCallId(callsToValues: any, selectedCallId: string|undefined) {
		if (selectedCallId) {
			return selectedCallId in callsToValues;
		}
		return false;
	}

	private _firstFunctionCall(callsToValues: any) {
		const calls: string[] = Object.keys(callsToValues);
		calls.sort();
		return calls[0];
	}

	private _selectedCallIdForFunction(callsToValues: any, selected: string|undefined) {
		if (!this._validCallId(callsToValues, selected)) {
			return this._firstFunctionCall(callsToValues);
		}
		return selected;
	}

	private _selectedCallIdsForFile(filePath: string) {
		const fileFunctions = this._liveValues[filePath];
		let selectedCallIds = this._callIdsForFile(filePath);
		Object.keys(fileFunctions).forEach(functionName => {
			selectedCallIds[functionName] = this._selectedCallIdForFunction(
				fileFunctions[functionName]['calls'], selectedCallIds[functionName]
			);
		});
		return selectedCallIds;
	}

	private _getSelectedFunctionCallIds() {
		Object.keys(this._liveValues).forEach(filePath => {
			this._selectedFunctionCallIds[filePath] = this._selectedCallIdsForFile(filePath);
		});
		return this._selectedFunctionCallIds;
	}

	private _liveValuesErrorMessage(title: string, body: string) {
		if (this.openCount >= 5) {
			return new Array(
				`<div class="centre">
					<div class="widthLimiter">
						<span><b>${title}</b> ${body}</span>
						<div id="postHolder">
							<div class="post" style="margin: 0px;">Please complete this <a href="https://forms.gle/7W5qATvzuqtpnTKZ6">short survey</a> so I can improve Live Coder.</div>
						</div>
					</div>
				</div>`,
				''
			);
		}
		return new Array(
			`<div class="centre">
				<div class="widthLimiter">
					<span><b>${title}</b> ${body}</span>
					<div id="postHolder">
						<div class="post">
							<h2>What's new in v1.0!</h2>
							<ul>
								<li><b>No more server</b>: Just run the extension and it works!</li>
								<li><b>goto links</b>: Click <span class="function_call_link sample">from function_name</span> links goto where functions were called from.</li>
								<li><b>Click to expand</b>: Click on values to see expanded versions.</li>
							</ul>
						</div>
					</div>
				</div>
			</div>`,
			''
		);
	}

	private _noLiveValuesResponse() {
		if (this._currentTestId === "") {
			return this._liveValuesErrorMessage('No active test.', 'Select a test class and method from the dropdown above.');
		}
		if (this._currentActiveTextEditor === undefined) {
			return this._liveValuesErrorMessage('No active editor.', 'Open a Python file to see it run.');
		}
		return null;
	}

	private _liveValuesResponseError(response: any) {
		if (response.errorType === 'ExtensionError') {
			this.dispose();
		} else if (response.errorType === 'ImportError') {
			response.message = response.message;
		}
		vscode.window.showErrorMessage(response.message);
	}

	private _assignLiveValuesAttributesFromResponse(response: any) {
		this._liveValues = response.live_values;
		this._callIdToFunction = response.call_id_to_function;
		this._selectedFunctionCallIds = this._getSelectedFunctionCallIds();
		this._testOutput = response.test_output.split('\n');
		const testClasses = response.test_classes;
		this._testClasses = testClasses;
	}

	private async _getLiveValues() {
		const failResponse = this._noLiveValuesResponse();
		if (failResponse) {
			return failResponse;
		}
		const response = await requestLiveValues(this._pythonPath, this._projectRoot, this._serverPort, this._currentTestId, this.testsRelativePath, this.testPattern);
		if (response.type === 'error') {
			this._liveValuesResponseError(response);
		}
		this._assignLiveValuesAttributesFromResponse(response);
		return this._getLiveValuesForCurrentEditor();
	}

	private _testStatus() {
		if (this._testOutput[0] === "F") {
			return 'Failed';
		} else if (this._testOutput[0] === "E") {
			return 'Error';
		}
		return 'Passed';
	}

	private _testResizeClass() {
		if (this._testOutputIsClosed) {
			return 'closed';
		}
		return 'open';
	}

	private _testOutputArrow() {
		if (this._testOutputIsClosed) {
			return '&#8594';
		}
		return '&#8600';
	}

	private _getTestOutput() {
		const testOutputHTML: string = this._linesAsHTML(this._testOutput);
		const testStatus = this._testStatus();
		const resizeClass = this._testResizeClass();
		const arrowString = this._testOutputArrow();

		return `<div id="testPanel"><div id="resize" class="${resizeClass}">
			<div id="testPanelResizer"></div>
			<div id="testHeader">
				<span id="testOuptutArrow">${arrowString}</span><b>Test Output:</b><span id="testStatus" class="test${testStatus}">${testStatus}</span>
			</div>
			<div id="testBody">
				${testOutputHTML}
			</div>
		</div></div>`;
	}

	private _noValuesForFile() {
		return new Array(
			`<div class="centre">
				<span>
					<b>File not ran by the selected test.</b>
					<span class="function_call_link clearLink" data-reference-id="start" data-reference-name="${this._callIdToFunction.start[1]}">open test start</span>
				</span>
			</div>`,
			this._getTestOutput()
		);
	}

	private _hideFunctionCall(selectedCallId: string, callId: string) {
		if (selectedCallId !== callId) {
			return 'hide';
		}
		return '';
	}

	private _htmlForFunctionCall(functionName: string, callId: string, html: string, selectedCallId: string) {
		const hide: string = this._hideFunctionCall(selectedCallId, callId);
		return `<div class="functionCall ${hide} functionName_${functionName}" id="FunctionCall_${callId}" data-reference-id="${callId}" data-reference-name="${functionName}">${html}</div>`;
	}

	private _disabledCallSelector(numberOfCalls: number) {
		if (numberOfCalls > 1) {
			return '';
		}
		return 'disabled';
	}

	private _functionButtons(functionName: string, calls: any) {
		const disabled: string = this._disabledCallSelector(Object.keys(calls).length);
		let buttons: string = `<button class="functionCallButton previous ${disabled}" data-functionName="${functionName}">&lt;</button>`;
		buttons += `<button class="functionCallButton next ${disabled}" data-functionName="${functionName}">&gt;</button>`;
		return buttons;
	}

	private _functionCallIds(calls: any) {
		let callIds: string[] = [];
		Object.keys(calls).forEach(callId => {
			callIds.push(`functionCall${callId}`);
		});
		return callIds.join(' ');
	}

	private _htmlForAFunction(functionInfo: any, selectedCallId: string, functionName: any) {
		let functionCallsHTML: string[] = new Array();
		Object.keys(functionInfo.calls).forEach(callId => {
			functionCallsHTML.push(
				this._htmlForFunctionCall(functionName, callId, functionInfo.calls[callId], selectedCallId)
			);
		});
		const callIds: string = this._functionCallIds(functionInfo.calls);
		const buttons: string = this._functionButtons(functionName, functionInfo.calls);
		return `<div class="function" id="${callIds}" style="top: ${(functionInfo.starting_line_number - 1) * 18}px">${buttons}${functionCallsHTML.join('')}</div>`;
	}

	private _htmlForFunctions(functionsToCalls: any, selectedFunctionCallIds: any) {
		let HTMLFunctions: string[] = new Array();
		Object.keys(functionsToCalls).forEach(functionName => {
			HTMLFunctions.push(
				this._htmlForAFunction(functionsToCalls[functionName], selectedFunctionCallIds[functionName], functionName)
			);
		});
		return HTMLFunctions.join('');
	}

    private _getLiveValuesForCurrentEditor() {
		const FunctionsToCalls = this._liveValues[this._currentFileName()];
		const selectedFunctionCallIds = this._selectedFunctionCallIds[this._currentFileName()];
		if (FunctionsToCalls === undefined) {
			return this._noValuesForFile();
		}
	
		let functionsHTML: string = this._htmlForFunctions(FunctionsToCalls, selectedFunctionCallIds);
		const testOutputHTML: string = this._getTestOutput();

		let lineCount = this._currentActiveTextEditor.document.lineCount + 100;
        return new Array(
			`<div class="padding" style="padding-bottom: ${lineCount * 18}px" onclick="console.log('clicked padding')"></div>${functionsHTML}`,
			testOutputHTML
		);
    }

    private _linesAsHTML(linesContent: string[]) {
        var HTMLlines = new Array(linesContent.length);
        for (let i = 0; i < linesContent.length; i++) {
            HTMLlines[i] = `<div style="height:18px;" class="view-line"><span>${linesContent[i]}</span></div>`;
        }
        return HTMLlines.join('');
	}

	private _currentFileNameShort() {
		const fullPath: string = this._currentActiveTextEditor.document.fileName;
		return fullPath.split('/').pop();
	}
	
	private _currentFileName() {
		const fullPath: string = this._currentActiveTextEditor.document.fileName;
		const projectRootTerms = this._projectRoot.split('/');
		const pathTerms = fullPath.split('/');
		const localPathTerms = pathTerms.slice(projectRootTerms.length);
		return localPathTerms.join('/');
	}

	private _openFunctionCall(callId: string, name: string) {
		const path = `${this._projectRoot}/${this._callIdToFunction[callId][0]}`;
		vscode.workspace.openTextDocument(path).then(doc => {
			vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		}, err => {
			console.log(err);	
		});
	}

	private _updateFunctionCallSelection(callId: string, name: string) {
		this._selectedFunctionCallIds[this._currentFileName()][name] = callId;
	}

}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function getScrollPosition(editor: vscode.TextEditor): number | undefined {
	if (!editor.visibleRanges.length) {
		return undefined;
	}

	const firstVisiblePosition = editor.visibleRanges[0].start;
	const lineNumber = firstVisiblePosition.line;
	const line = editor.document.lineAt(lineNumber);
	const progress = firstVisiblePosition.character / (line.text.length + 2);
	return (lineNumber + progress) * 18;
}

async function startedBitly() {
    var options = {
        method: 'GET',
        uri: `http://bit.ly/2kgZWjN`,
    };
    await request.get(options);
}
async function failedStartBitly() {
    var options = {
        method: 'GET',
        uri: `http://bit.ly/2ltwebx`,
    };
    await request.get(options);
}
async function serverFailedBitly() {
    var options = {
        method: 'GET',
        uri: `http://bit.ly/2lYrtqD`,
    };
    await request.get(options);
}
async function updateWebViewBitly() {
    var options = {
        method: 'GET',
        uri: `http://bit.ly/2jXaDI1`,
    };
    await request.get(options);
}


async function newProjectSession(serverPort: number, projectRoot: string, testsRelativePath: string, testPattern: string) {
    var options = {
        method: 'POST',
        uri: `http://0.0.0.0:${serverPort}/new_project`,
        json: true,
        body: {
            root_path: projectRoot,
			tests_relative_path: testsRelativePath,
			test_pattern: testPattern
        }
    };
    const response = await request.post(options);
	return response;
}

async function requestLiveValues(pythonPath: string, projectRoot: string, serverPort: number, testId: string, testsRelativePath: string, testPattern: string) {
    var options = {
        method: 'POST',
        uri: `http://0.0.0.0:${serverPort}/live_values`,
        json: true,
        body: {
			python_path: pythonPath,
			root_path: projectRoot,
			tests_relative_path: testsRelativePath,
			test_pattern: testPattern,
            test_id: testId
        }
    };
    const response = await request.post(options);
	return response;
}

function getDuplicates(array: string[]) {
    var duplicates = new Map<string, number[]>();
    for (var i = 0; i < array.length; i++) {
        if (duplicates.has(array[i])) {
            duplicates.get(array[i])!.push(i);
        } else if (array.lastIndexOf(array[i]) !== i) {
            duplicates.set(array[i], [i]);
        }
    }
    return duplicates;
}

