
///////////// Main

var mousedownPosition;
var currentScroll = 0;
var setMarginTop = false;
var lastScrolledWebview = 0;
var lastScrolledEditor = 0;

(function () {
    const vscode = acquireVsCodeApi();

    handleMessagesFromExtension();
    handleScrolling(vscode);
    handleTestPickers(vscode);
    handleTestPanelResizer(vscode);
    handleToolTip();
    handleFunctionCallLinks(vscode);
    handlefunctionCallButtons(vscode);
}());

///////////// Setup Functions

function handleMessagesFromExtension() {
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'editorScroll':
                editorScrollMessage(message.scroll);
        }
    });
}

function _throttle(func, wait) {
    var time = Date.now();
    return function() {
      if ((time + wait - Date.now()) < 0) {
        func();
        time = Date.now();
      }
    }
}

function handleTestPickers(vscode) {
    document.getElementById('testClassPicker').addEventListener(
        'change',
        function() { pickedTestClass(vscode) },
        false
     );
    document.getElementById('testMethodPicker').addEventListener(
        'change',
        function() { pickedTestMethod(vscode) },
        false
    );
}

function handleTestPanelResizer(vscode) {
    var testPanelResizer = document.getElementById("testPanelResizer");
    if (testPanelResizer != null) {
        addTestPanelListeners(vscode);
    }
}

function handleToolTip() {
    var snippets = document.getElementsByClassName('highlight');
    for (let i = 0; i < snippets.length; i++) {
        const snippetDiv = snippets[i];
        if (snippetDiv.id == 'tooltip') {
            continue;
        }
        snippetDiv.addEventListener("click", function(event) {
            showToolTip(event.currentTarget);
        });
    }
    var tooltipBackground = document.getElementById('tooltipBackground');
    tooltipBackground.addEventListener("click", function() { hideToolTip(); });
}

function handleFunctionCallLinks(vscode) {
    var links = document.getElementsByClassName('function_call_link');
    for (let i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function(event) { openFunctionCall(vscode, event) });
    }
}

function handlefunctionCallButtons(vscode) {
    var buttons = document.getElementsByClassName('functionCallButton');
    for (let i = 0; i < buttons.length; i++) {
        var button = buttons[i];
        if (button.classList.contains('previous')) {
            button.addEventListener('click', function(event) { previousFunction(vscode, event.currentTarget) });
        } else {
            button.addEventListener('click', function(event) { nextFunction(vscode, event.currentTarget) });
        }
    }
}

///////////// Scrolling

function _notScrollingEditor() {
    return (Date.now() - lastScrolledEditor) > 50;
}

function editorScrollMessage(scroll) {
    currentScroll = scroll;
    var liveValues = document.getElementById('scrollableLiveValues')
    liveValues.scrollTop = currentScroll;
    lastScrolledEditor = Date.now();
    _setMarginTop(liveValues, currentScroll);
}

function _setMarginTop(liveValues, scroll) {
    if (scroll <= 2) {
        if (setMarginTop == false) {
            liveValues.style.marginTop = '23px';
            setMarginTop = true;
        }
    } else if (setMarginTop) {
        liveValues.style.marginTop = '';
        setMarginTop = false;
    }
}

function _scrollToLineNo(scroll) {
    return Math.floor(scroll/18);
}

function _messageRevealLine(vscode) {
    vscode.postMessage({command: 'revealLine', line: _scrollToLineNo(currentScroll)});
}

function handleScrolling(vscode) {
    var liveValues = document.getElementById('scrollableLiveValues');
    liveValues.addEventListener(
        'scroll',
        _throttle(() => {
            if (_notScrollingEditor()) {
                currentScroll = liveValues.scrollTop;
                lastScrolledWebview = Date.now();
                _messageRevealLine(vscode);
                _setMarginTop(liveValues, currentScroll);
            }
        }, 10)
    );
}

///////////// Test Panel

function disableSelect(event) {
    event.preventDefault();
}

function _removeResizerListeners() {
    document.removeEventListener("mousemove", resizeTestOutput, false);
    window.removeEventListener('selectstart', disableSelect);
}

function _addTestHeaderListener(vscode) {
    var testHeader = document.getElementById('testHeader');
    testHeader.addEventListener("click", function() { toggleTestHeader(vscode) }, false);
}

function _testPanelOpen() {
    return document.getElementById("testPanelResizer").className != 'closed'
}

function addTestPanelListeners(vscode) {
    document.addEventListener("mouseup", _removeResizerListeners, false);
    document.addEventListener("mouseleave", _removeResizerListeners, false);
    _addTestHeaderListener(vscode);
    if (_testPanelOpen()) {
        _startPanelResizer();
    }
}

function _resizePanel(event) {
    mousedownPosition = event.y;
    document.addEventListener("mousemove", resizeTestOutput, false);
    window.addEventListener('selectstart', disableSelect);
}

function _startPanelResizer() {
    var testPanelResizer = document.getElementById("testPanelResizer");
    testPanelResizer.addEventListener("mousedown", _resizePanel);
}

function _openTestHeader() {
    document.getElementById('resize').className = 'open';
    document.getElementById('testOuptutArrow').innerHTML = '&#8600;';
    _startPanelResizer();
}

function _closeTestHeader() {
    resize.className = 'closed';
    testOuptutArrow.innerHTML = '&#8594;';
    _stopPanelResizer();
}

function _stopPanelResizer() {
    var testPanelResizer = document.getElementById("testPanelResizer");
    testPanelResizer.removeEventListener("mousedown", _resizePanel);
}

function toggleTestHeader(vscode) {
    if (resize.className == 'closed') {
        _openTestHeader();
        vscode.postMessage({command: 'toggleTestOutput', value: 'open'});
    } else {
        _closeTestHeader();
        vscode.postMessage({command: 'toggleTestOutput', value: 'close'});
    }
}

function _testBodyHeight() {
    var testBody = document.getElementById('testBody');
    var height = parseInt(testBody.style.height);
    if (isNaN(height)) {
        return 100;
    }
    return height;
}

function resizeTestOutput(e) {
    const heightDiff = mousedownPosition - e.y;
    const newHeight = _testBodyHeight() + heightDiff;
    if (newHeight >= 100) {
        testBody.style.height = newHeight + "px";
        mousedownPosition = e.y;
    }
}

///////////// ToolTip

function styleToolTip(tooltip, highlightDiv) {
    var rect = highlightDiv.getBoundingClientRect();
    tooltip.style.top = parseInt(rect.top) + 'px';
    tooltip.style.left = '40px';
    tooltip.style.width = `calc(100vw - 40px - 50px)`;
    tooltip.style.display = 'block';
}

function styleToolTipBackground() {
    var liveValues = document.getElementById('scrollableLiveValues');
    var background = document.getElementById('tooltipBackground');
    background.style.width = liveValues.scrollWidth + 'px';
    background.style.height = liveValues.scrollHeight + 'px';
}

function showToolTip(highlightDiv) {
    var tooltip = document.getElementById('tooltip');
    tooltip.innerHTML = highlightDiv.innerHTML;
    styleToolTip(tooltip, highlightDiv);
    styleToolTipBackground();
    var tooltipBackground = document.getElementById('tooltipBackground');
    tooltipBackground.className = 'show';
}

function hideToolTip() {
    var tooltip = document.getElementById('tooltip');
    tooltip.innerHTML = '';
    tooltip.style.top = '-30px';
    var background = document.getElementById('tooltipBackground');
    background.className = '';
    background.style.width = '';
    background.style.height = '';
}

///////////// TestPickers

function pickedTestMethod(vscode) {
    if (_pickedNull('testMethodPicker')) {
        vscode.postMessage({command: 'clearLiveValues'});
    } else {
        _messageRunTestMethod(vscode);
    }
}

function _pickedNull(selectId) {
    return document.getElementById(selectId).value == "";
}

function _messageRunTestMethod(vscode) {
    const methodPicker = document.getElementById("testMethodPicker");
    vscode.postMessage({
        command: 'runTestMethod',
        method: methodPicker.value,
        classIndex: _pickedClassIndex(),
        methodIndex: methodPicker.selectedIndex
    });
}

function _pickedClassIndex() {
    const selectedIndex = document.getElementById("testClassPicker").selectedIndex
    const nullOptions = 2;
    return selectedIndex - nullOptions;
}

function _selectedOption(selectId) {
    var select = document.getElementById(selectId);
    return select.options[select.selectedIndex];
}

function _listData(element, name) {
    return element.dataset[name].split(',');
}

function pickedTestClass(vscode) {
    if (_pickedNull('testClassPicker')) {
        _defaultTestMethods();
        pickedTestMethod(vscode);
    } else {
        var selectedOption = _selectedOption('testClassPicker');
        newTestMethods(
            _listData(selectedOption, 'method_names'),
            _listData(selectedOption, 'method_ids')
        );
        pickedTestMethod(vscode);
    }
}

function _defaultTestMethods() {
    var methodPicker = document.getElementById("testMethodPicker");
    removeOptions(methodPicker);
    methodPicker.appendChild(newOption("", "No Test Methods"));
    methodPicker.value = "";
}

function newTestMethods(method_names, method_ids) {
    var methodPicker = document.getElementById("testMethodPicker");
    removeOptions(methodPicker);
    for (i = 0; i < method_names.length; i++) {
        methodPicker.appendChild(
            newOption(method_ids[i], method_names[i])
        );
    }
    methodPicker.value = method_ids[0];
}

function newOption(value, text) {
    var opt = document.createElement('option');
    opt.value = value;
    opt.text = text;
    return opt;
}

function removeOptions(select) {
    for (i = select.options.length-1; i > -1; i--) {
        select.options.remove(i);
    }
}

///////////// Function Call Selector

function _findCurrentSelection(functionCalls) {
    for (let index = 0; index < functionCalls.length; index++) {
        const call = functionCalls[index];
        if (!(call.classList.contains('hide'))) {
            return index;
        }
    }
    return 0;
}

function _setSelection(vscode, functionCalls, selectedIndex) {
    for (let i = 0; i < functionCalls.length; i++) {
        const call = functionCalls[i];
        if (i == selectedIndex) {
            if (call.classList.contains('hide')) {
                call.classList.remove("hide");
            }
            const [name, callId] = _callData(call);
            _tellExtension(vscode, callId, name);
        } else {
            if (!(call.classList.contains('hide'))) {
                call.classList.add("hide");
            }
        }
    }
}

function _tellExtension(vscode, callId, name) {
    vscode.postMessage({command: 'updateFunctionCallSelection', callId: callId, name: name});
}

function _inc(num, max) {
    num++;
    if (num >= max) {
        return 0;
    }
    return num;
}

function nextFunction(vscode, node) {
    const functionName = node.dataset.functionname;
    var functionCalls = document.getElementsByClassName("functionName_" + functionName);
    var selection = _findCurrentSelection(functionCalls);
    selection = _inc(selection, functionCalls.length);
    _setSelection(vscode, functionCalls, selection);
}

function _dec(num, max) {
    num--;
    if (num < 0) {
        return max - 1;
    }
    return num;
}

function previousFunction(vscode, node) {
    const functionName = node.dataset.functionname;
    var functionCalls = document.getElementsByClassName("functionName_" + functionName);
    var selection = _findCurrentSelection(functionCalls);
    selection = _dec(selection, functionCalls.length);
    _setSelection(vscode, functionCalls, selection);
}


///////////// Function Call Links

function _callData(element) {
    return [element.dataset.referenceName, element.dataset.referenceId];
}

function _selectFunctionCall(callId, functionName, functionCalls) {
    for (let i = 0; i < functionCalls.length; i++) {
        if (functionCalls[i].id == "FunctionCall_" + callId) {
            return i;
        }
    }
    throw `Missing function call "${callId}" for function "${functionName}"`;
}

function _tooHigh(rect) {
    return rect.top < 100;
}

function _cantSee(rect) {
    return _tooHigh(rect) || rect.bottom > window.innerHeight - 100;
}

function _modScroll(mod) {
    document.getElementById('scrollableLiveValues').scrollTop = currentScroll + mod;
}

function _scrollToFunction(node) {
    const rect = node.getBoundingClientRect();
    if (_cantSee(rect)) {
        if (_tooHigh(rect)) {
            _modScroll(- 100 + rect.top);
        } else {
            _modScroll(rect.bottom - window.innerHeight + 100);
        }
    }
}

function openFunctionCall(vscode, event) {
    const [name, callId] = _callData(event.currentTarget);
    const functionCalls = document.getElementsByClassName("functionName_" + name);
    if (functionCalls.length > 0) {
        _viewFunctionCall(vscode, callId, name, functionCalls)
    } else {
        _openFunctionCall(vscode, callId, name);
    }
}

function _viewFunctionCall(vscode, callId, name, functionCalls) {
    const selection = _selectFunctionCall(callId, name, functionCalls);
    _setSelection(vscode, functionCalls, selection);
    _scrollToFunction(functionCalls[selection]);
}

function _openFunctionCall(vscode, callId, name) {
    vscode.postMessage({command: 'openFunctionCall', callId: callId, name: name});
}
