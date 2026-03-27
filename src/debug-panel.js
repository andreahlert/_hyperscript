/**
 * hyperscript Debug Panel
 * A web component for debugging hyperscript in real-time.
 * Load via CDN: <script src="unpkg.com/hyperscript.org/dist/debug-panel.js"></script>
 *
 * WARNING: Development tool only. Do not ship in production.
 *
 * Security note: This debugger intentionally renders HTML from hyperscript internals
 * (AST source, prettyPrint output). All user-facing strings are escaped via escapeHTML().
 * The console REPL evaluates arbitrary hyperscript by design (same as browser DevTools).
 */
(function (self, factory) {
    var plugin = factory(self);

    if (typeof exports === "object" && typeof exports["nodeName"] !== "string") {
        module.exports = plugin;
    } else {
        if ("_hyperscript" in self) {
            self._hyperscript.use(plugin);
        } else {
            // Intercept _hyperscript assignment to register before browserInit
            Object.defineProperty(self, "_hyperscript", {
                configurable: true,
                enumerable: true,
                get: function () {
                    return undefined;
                },
                set: function (hs) {
                    delete self._hyperscript;
                    self._hyperscript = hs;
                    hs.use(plugin);
                },
            });
        }
    }
})(typeof self !== "undefined" ? self : this, function (globalScope) {
    return function (_hyperscript) {
        if (_hyperscript._debugPanelRegistered) return;
        _hyperscript._debugPanelRegistered = true;

        // ── Utilities ──
        // All user-facing text is sanitized through escapeHTML before rendering.
        // HTML markup in renderCode/prettyPrint is generated from trusted internal
        // hyperscript AST data, not from user input.

        function escapeHTML(unsafe) {
            if (typeof unsafe !== "string") unsafe = String(unsafe != null ? unsafe : "");
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        function truncate(str, len) {
            if (str.length <= len) return str;
            return str.substr(0, len) + "\u2026";
        }

        function prettyPrint(obj) {
            if (obj == null) return "null";
            var result;
            if (typeof Element !== "undefined" && Element.prototype.isPrototypeOf(obj)) {
                result = '&lt;<span class="token tagname">' + obj.tagName.toLowerCase() + "</span>";
                for (var attr of Array.from(obj.attributes)) {
                    if (attr.specified) {
                        result +=
                            ' <span class="token attr">' +
                            escapeHTML(attr.nodeName) +
                            '</span>=<span class="token string">"' +
                            escapeHTML(truncate(attr.textContent, 10)) +
                            '"</span>';
                    }
                }
                result += ">";
                return result;
            } else if (obj.call) {
                if (obj.hyperfunc) result = "def " + obj.hypername + " ...";
                else result = "function " + obj.name + "(...) {...}";
            } else if (obj.toString) {
                result = obj.toString();
            }
            return escapeHTML((result || "undefined").trim());
        }

        function traverse(ge) {
            var rv = [];
            (function recurse(node) {
                rv.push(node);
                if ("children" in node) {
                    for (var child of node.children) recurse(child);
                }
            })(ge);
            return rv;
        }

        function formatTime(date) {
            var h = String(date.getHours()).padStart(2, "0");
            var m = String(date.getMinutes()).padStart(2, "0");
            var s = String(date.getSeconds()).padStart(2, "0");
            var ms = String(date.getMilliseconds()).padStart(3, "0");
            return h + ":" + m + ":" + s + "." + ms;
        }

        // Creates a DOM element from trusted internal markup.
        // Used only for debugger UI rendering with escaped user data.
        function setTrustedHTML(element, html) {
            element.innerHTML = html;
        }

        // ── Panel Registry ──

        var panels = new Set();

        function notifyPanels(method) {
            var args = Array.prototype.slice.call(arguments, 1);
            for (var p of panels) {
                if (p[method]) p[method].apply(p, args);
            }
        }

        // ── HDB Factory ──

        function HDB(ctx, runtime, breakpoint, _hs) {
            var cmd = breakpoint;
            var cmdMap = [];
            var bus = new EventTarget();
            var consoleHistory = [];

            var brk = function (_ctx) {
                console.log("=== HDB///_hyperscript/debugger ===");
                notifyPanels("attachHdb", hdb, ctx);
                return new Promise(function (resolve) {
                    bus.addEventListener(
                        "continue",
                        function () {
                            resolve(runtime.findNext(cmd, ctx));
                            cmd = null;
                            notifyPanels("detachHdb");
                        },
                        { once: true }
                    );
                });
            };

            var continueExec = function () {
                bus.dispatchEvent(new Event("continue"));
            };

            var stepOver = function () {
                if (!cmd) return continueExec();
                var result =
                    cmd && cmd.type === "breakpointCommand"
                        ? runtime.findNext(cmd, ctx)
                        : runtime.unifiedEval(cmd, ctx);
                if (!result) { cmd = null; bus.dispatchEvent(new Event("continue")); return; }
                if (result.type === "implicitReturn") return stepOut();
                if (result && result.then instanceof Function) {
                    return result.then(function (next) {
                        cmd = next;
                        bus.dispatchEvent(new Event("step"));
                        logCommand();
                    });
                } else if (result.halt_flag) {
                    bus.dispatchEvent(new Event("continue"));
                } else {
                    cmd = result;
                    bus.dispatchEvent(new Event("step"));
                    logCommand();
                }
            };

            var stepOut = function () {
                if (!ctx.meta.caller) return continueExec();
                var callingCmd = ctx.meta.callingCommand;
                var oldMe = ctx.me;
                ctx = ctx.meta.caller;
                console.log("[hdb] stepping out into " + ctx.meta.feature.displayName);
                if (ctx.me instanceof Element && ctx.me !== oldMe) {
                    console.log("[hdb] me: ", ctx.me);
                }
                cmd = runtime.findNext(callingCmd, ctx);
                cmd = runtime.findNext(cmd, ctx);
                logCommand();
                bus.dispatchEvent(new Event("step"));
            };

            var skipTo = function (toCmdIndex) {
                var toCmd = cmdMap[toCmdIndex];
                if (!toCmd) return;
                cmd = toCmd.cmd;
                bus.dispatchEvent(new Event("skip"));
            };

            var logCommand = function () {
                var hasSource = cmd && cmd.sourceFor instanceof Function;
                var cmdSource = hasSource ? cmd.sourceFor() : "-- " + (cmd ? cmd.type : "end");
                console.log("[hdb] current command: " + cmdSource);
            };

            var renderCode = function () {
                if (!cmd || !cmd.programSource) return "";
                cmdMap = [];
                var src = cmd.programSource;

                var feat = cmd;
                while (feat.parent && !feat.isFeature) feat = feat.parent;

                var all = traverse(feat);
                for (var j = 0; j < all.length; j++) {
                    var c = all[j];
                    if (!c.startToken) continue;
                    cmdMap.push({
                        index: c.startToken.start,
                        cmd: c,
                    });
                }

                if (cmdMap.length === 0) return escapeHTML(src);

                // Build HTML from trusted AST source code.
                // Skip buttons use data attributes with integer indices (not user input).
                var rv = escapeHTML(src.slice(0, cmdMap[0].index));
                for (var i = 0; i < cmdMap.length; i++) {
                    var obj = cmdMap[i];
                    var end = cmdMap[i + 1] ? cmdMap[i + 1].index : undefined;
                    var skipBtn =
                        '<button class="skip-btn" data-cmd="' + i + '" title="Skip to">\u21B3</button>';
                    if (obj.cmd === cmd) {
                        rv +=
                            skipBtn +
                            '<span class="current">' +
                            escapeHTML(src.slice(obj.index, end)) +
                            "</span>";
                    } else {
                        rv += skipBtn + escapeHTML(src.slice(obj.index, end));
                    }
                }
                return rv;
            };

            var evaluateExpression = function (input) {
                consoleHistory.push(input);
                var output;
                try {
                    var parsed = _hs.parse(input);
                    output = parsed.execute ? parsed.execute(ctx) : parsed.evaluate(ctx);
                } catch (e) {
                    output = "[Error] " + e.message;
                }
                return { input: input, output: output };
            };

            var hdb = {
                break: brk,
                continueExec: continueExec,
                stepOver: stepOver,
                stepOut: stepOut,
                skipTo: skipTo,
                evaluateExpression: evaluateExpression,
                renderCode: renderCode,
                getCtx: function () {
                    return ctx;
                },
                getCmd: function () {
                    return cmd;
                },
                getCmdMap: function () {
                    return cmdMap;
                },
                getConsoleHistory: function () {
                    return consoleHistory;
                },
                onStep: function (cb) {
                    bus.addEventListener("step", cb);
                    bus.addEventListener("skip", cb);
                },
                onDone: function (cb) {
                    bus.addEventListener("continue", cb, { once: true });
                },
                offStep: function (cb) {
                    bus.removeEventListener("step", cb);
                    bus.removeEventListener("skip", cb);
                },
            };

            return hdb;
        }

        // ── Breakpoint Command Registration ──

        _hyperscript.debuggerOpen = true;

        _hyperscript.addCommand("breakpoint", function (parser, runtime, tokens) {
            if (!tokens.matchToken("breakpoint")) return;

            var hdb;

            return {
                op: function (ctx) {
                    globalScope._hyperscript.hdb = hdb = HDB(ctx, runtime, this, _hyperscript);

                    if (panels.size === 0) {
                        return runtime.findNext(this, ctx);
                    }

                    try {
                        return hdb.break(ctx);
                    } catch (e) {
                        console.error(e, e.stack);
                    }
                },
            };
        });

        // ── CSS ──

        // CSS copied from htmx-devtools tokens.css + panel.css, with float-specific additions.
        // Class names match htmx-devtools exactly for visual consistency.
        var PANEL_CSS = [
            // tokens.css (htmx-devtools design system)
            ":host {",
            "    all: initial;",
            "    display: block;",
            "    position: fixed;",
            "    z-index: 2147483647;",
            "    --bg-primary: #1e1e1e;",
            "    --bg-secondary: #252526;",
            "    --bg-tertiary: #2d2d2d;",
            "    --bg-hover: #3c3c3c;",
            "    --bg-active: #094771;",
            "    --text-primary: #cccccc;",
            "    --text-secondary: #969696;",
            "    --text-muted: #6a6a6a;",
            "    --border: #3c3c3c;",
            "    --border-focus: #007acc;",
            "    --accent: #3b82f6;",
            "    --success: #22c55e;",
            "    --error: #ef4444;",
            "    --warning: #f59e0b;",
            "    --info: #06b6d4;",
            "    --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace;",
            "    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
            "    --radius: 4px;",
            "    --radius-sm: 2px;",
            "}",
            ":host([position='bottom-right']), :host(:not([position])) {",
            "    bottom: 12px; right: 12px;",
            "}",
            ":host([position='bottom-left']) {",
            "    bottom: 12px; left: 12px;",
            "}",
            ":host([position='top-right']) {",
            "    top: 12px; right: 12px;",
            "}",
            ":host([position='top-left']) {",
            "    top: 12px; left: 12px;",
            "}",

            // panel.css reset (htmx-devtools)
            "* { margin: 0; padding: 0; box-sizing: border-box; }",
            ".app {",
            "    font-family: var(--font-sans);",
            "    font-size: 13px;",
            "    line-height: 1.5;",
            "    color: var(--text-primary);",
            "    background: var(--bg-primary);",
            "    width: 480px;",
            "    height: 420px;",
            "    display: flex;",
            "    flex-direction: column;",
            "    overflow: hidden;",
            "    border-radius: 6px;",
            "    border: 1px solid var(--border);",
            "    box-shadow: 0 8px 32px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3);",
            "}",
            ".app.collapsed { height: 34px; }",
            ".app.collapsed .tab-bar,",
            ".app.collapsed .app__content { display: none; }",

            // Drag header (float-only, not in htmx-devtools)
            ".drag-header {",
            "    display: flex;",
            "    align-items: center;",
            "    justify-content: space-between;",
            "    height: 34px;",
            "    padding: 0 6px;",
            "    background: var(--bg-secondary);",
            "    border-bottom: 1px solid var(--border);",
            "    cursor: grab;",
            "    user-select: none;",
            "    flex-shrink: 0;",
            "}",
            ".app.collapsed .drag-header { border-bottom: none; }",
            ".drag-header:active { cursor: grabbing; }",
            ".drag-header__left {",
            "    display: flex;",
            "    align-items: center;",
            "    gap: 8px;",
            "}",
            ".drag-header__title {",
            "    font-family: var(--font-sans);",
            "    font-weight: 600;",
            "    font-size: 13px;",
            "    color: var(--text-primary);",
            "}",
            ".drag-header__version {",
            "    font-size: 11px;",
            "    padding: 2px 8px;",
            "    border-radius: 10px;",
            "    font-weight: 600;",
            "    font-family: var(--font-mono);",
            "    background: #7c3aed;",
            "    color: #fff;",
            "}",
            ".drag-header__actions {",
            "    display: flex;",
            "    gap: 2px;",
            "}",

            // Status dot (htmx-devtools)
            ".status-dot {",
            "    width: 8px; height: 8px;",
            "    border-radius: 50%;",
            "    flex-shrink: 0;",
            "}",
            ".status-dot--success { background: var(--success); }",
            ".status-dot--pending { background: var(--warning); animation: pulse 1.5s infinite; }",
            "@keyframes pulse {",
            "    0%, 100% { opacity: 1; }",
            "    50% { opacity: .3; }",
            "}",

            // Tab bar (htmx-devtools .tab-bar)
            ".tab-bar {",
            "    display: flex;",
            "    align-items: center;",
            "    background: var(--bg-secondary);",
            "    border-bottom: 1px solid var(--border);",
            "    height: 34px;",
            "    padding: 0 6px;",
            "    gap: 2px;",
            "    user-select: none;",
            "    flex-shrink: 0;",
            "}",
            ".tab-bar__tab {",
            "    display: flex;",
            "    align-items: center;",
            "    gap: 4px;",
            "    padding: 4px 12px;",
            "    height: 100%;",
            "    border: none;",
            "    background: none;",
            "    color: var(--text-secondary);",
            "    font-family: var(--font-sans);",
            "    font-size: 13px;",
            "    cursor: pointer;",
            "    border-bottom: 2px solid transparent;",
            "    white-space: nowrap;",
            "}",
            ".tab-bar__tab:hover {",
            "    color: var(--text-primary);",
            "    background: var(--bg-hover);",
            "}",
            ".tab-bar__tab--active {",
            "    color: var(--text-primary);",
            "    border-bottom-color: var(--accent);",
            "}",
            ".tab-bar__spacer { flex: 1; }",
            ".tab-bar__info {",
            "    color: var(--text-muted);",
            "    font-size: 11px;",
            "    padding: 0 8px;",
            "}",

            // Badge (htmx-devtools)
            ".badge {",
            "    display: inline-flex;",
            "    align-items: center;",
            "    justify-content: center;",
            "    min-width: 16px;",
            "    height: 16px;",
            "    padding: 0 4px;",
            "    border-radius: 8px;",
            "    font-size: 10px;",
            "    font-weight: 600;",
            "}",
            ".badge--error { background: var(--error); color: #fff; }",
            ".badge--info { background: var(--accent); color: #fff; }",
            ".badge.hidden { display: none; }",

            // Layout (htmx-devtools)
            ".app__content {",
            "    flex: 1;",
            "    overflow: hidden;",
            "}",
            ".tab-pane {",
            "    display: none;",
            "    flex-direction: column;",
            "    height: 100%;",
            "    overflow: hidden;",
            "}",
            ".tab-pane.active { display: flex; }",

            // Toolbar (htmx-devtools)
            ".toolbar {",
            "    display: flex;",
            "    align-items: center;",
            "    gap: 6px;",
            "    padding: 5px 10px;",
            "    background: var(--bg-secondary);",
            "    border-bottom: 1px solid var(--border);",
            "    flex-shrink: 0;",
            "}",
            ".toolbar__btn {",
            "    display: flex;",
            "    align-items: center;",
            "    justify-content: center;",
            "    width: 26px;",
            "    height: 26px;",
            "    border: none;",
            "    background: none;",
            "    color: var(--text-secondary);",
            "    cursor: pointer;",
            "    border-radius: var(--radius-sm);",
            "    font-size: 14px;",
            "}",
            ".toolbar__btn:hover {",
            "    background: var(--bg-hover);",
            "    color: var(--text-primary);",
            "}",
            ".toolbar__btn:disabled {",
            "    color: var(--text-muted);",
            "    cursor: not-allowed;",
            "}",
            ".toolbar__btn:disabled:hover { background: none; }",

            // List items (htmx-devtools)
            ".list-item {",
            "    display: flex;",
            "    align-items: center;",
            "    gap: 8px;",
            "    padding: 5px 10px;",
            "    cursor: default;",
            "    border-bottom: 1px solid var(--border);",
            "}",
            ".list-item:hover { background: var(--bg-hover); }",

            // Verb badge (htmx-devtools, reused for event types)
            ".verb-badge {",
            "    font-family: var(--font-mono);",
            "    font-size: 11px;",
            "    font-weight: 700;",
            "    padding: 2px 5px;",
            "    border-radius: var(--radius-sm);",
            "    text-transform: uppercase;",
            "    flex-shrink: 0;",
            "}",
            ".verb-badge--error { background: var(--error); color: #fff; }",
            ".verb-badge--load { background: var(--success); color: #000; }",
            ".verb-badge--htmx { background: var(--accent); color: #fff; }",
            ".verb-badge--ready { background: var(--info); color: #000; }",
            ".verb-badge--info { background: var(--bg-tertiary); color: var(--text-secondary); }",

            // Time (htmx-devtools)
            ".time {",
            "    font-family: var(--font-mono);",
            "    font-size: 11px;",
            "    color: var(--text-muted);",
            "    white-space: nowrap;",
            "    flex-shrink: 0;",
            "    min-width: 80px;",
            "}",

            // Detail text
            ".detail-text {",
            "    flex: 1;",
            "    overflow: hidden;",
            "    text-overflow: ellipsis;",
            "    white-space: nowrap;",
            "    color: var(--text-secondary);",
            "    font-family: var(--font-mono);",
            "    font-size: 12px;",
            "}",

            // Empty state (htmx-devtools)
            ".empty-state {",
            "    display: flex;",
            "    flex-direction: column;",
            "    align-items: center;",
            "    justify-content: center;",
            "    height: 100%;",
            "    color: var(--text-muted);",
            "    gap: 8px;",
            "    padding: 24px;",
            "    text-align: center;",
            "}",
            ".empty-state__title {",
            "    font-size: 14px;",
            "    font-weight: 600;",
            "    color: var(--text-secondary);",
            "}",

            // Code view
            ".code-container {",
            "    flex: 1;",
            "    overflow: auto;",
            "    padding: 10px;",
            "    background: var(--bg-primary);",
            "}",
            ".code-pre {",
            "    margin: 0;",
            "    font-family: var(--font-mono);",
            "    font-size: 12px;",
            "    line-height: 1.5;",
            "    color: var(--text-primary);",
            "    white-space: pre-wrap;",
            "    word-break: break-word;",
            "}",
            ".code-pre .current {",
            "    background: var(--bg-active);",
            "    border-left: 3px solid var(--accent);",
            "    padding-left: 4px;",
            "    display: inline;",
            "}",
            ".code-pre .skip-btn {",
            "    display: inline-block;",
            "    background: none;",
            "    border: none;",
            "    color: var(--text-muted);",
            "    cursor: pointer;",
            "    font-size: 10px;",
            "    padding: 0 2px;",
            "    margin-right: 1px;",
            "    line-height: 1.4;",
            "    vertical-align: middle;",
            "    border-radius: var(--radius-sm);",
            "}",
            ".code-pre .skip-btn:hover {",
            "    background: var(--bg-hover);",
            "    color: var(--text-primary);",
            "}",

            // Key-value table (htmx-devtools .kv-table pattern)
            ".kv-table {",
            "    width: 100%;",
            "    font-family: var(--font-mono);",
            "    font-size: 12px;",
            "}",
            ".kv-table__row {",
            "    display: flex;",
            "    padding: 3px 10px;",
            "    border-bottom: 1px solid var(--border);",
            "}",
            ".kv-table__row:hover { background: var(--bg-hover); }",
            ".kv-table__key {",
            "    color: var(--info);",
            "    min-width: 120px;",
            "    flex-shrink: 0;",
            "    font-weight: 600;",
            "}",
            ".kv-table__value {",
            "    color: var(--text-primary);",
            "    word-break: break-all;",
            "}",

            // Detail section (htmx-devtools)
            ".detail-section {",
            "    padding: 10px;",
            "    border-bottom: 1px solid var(--border);",
            "}",
            ".detail-section__title {",
            "    font-size: 12px;",
            "    font-weight: 600;",
            "    text-transform: uppercase;",
            "    color: var(--text-muted);",
            "    margin-bottom: 5px;",
            "}",

            // Console
            ".console-list {",
            "    list-style: none;",
            "    overflow-y: auto;",
            "    flex: 1;",
            "    padding: 8px;",
            "    background: var(--bg-primary);",
            "    font-family: var(--font-mono);",
            "    font-size: 12px;",
            "}",
            ".console-entry { margin-bottom: 6px; }",
            ".console-entry .input { color: var(--info); display: block; }",
            '.console-entry .input::before { content: ">> "; color: var(--text-muted); }',
            ".console-entry .output { color: var(--text-primary); display: block; padding-left: 2ch; }",
            '.console-entry .output::before { content: "<- "; color: var(--text-muted); }',
            ".console-entry .output.error { color: var(--error); }",
            ".console-form {",
            "    display: flex;",
            "    border-top: 1px solid var(--border);",
            "    background: var(--bg-primary);",
            "    flex-shrink: 0;",
            "}",
            ".console-form input {",
            "    flex: 1;",
            "    background: transparent;",
            "    border: none;",
            "    color: var(--text-primary);",
            "    font-family: var(--font-mono);",
            "    font-size: 12px;",
            "    padding: 8px 10px;",
            "    outline: none;",
            "}",
            ".console-form input:focus { box-shadow: 0 -1px 0 0 var(--border-focus) inset; }",
            ".console-form input::placeholder { color: var(--text-muted); }",

            // Token colors
            ".token.tagname { color: var(--info); font-weight: bold; }",
            ".token.attr { color: var(--warning); font-style: italic; }",
            ".token.string { color: var(--success); }",
            ".token.keyword { color: var(--accent); }",

            // Scrollbar (htmx-devtools)
            "::-webkit-scrollbar { width: 8px; height: 8px; }",
            "::-webkit-scrollbar-track { background: var(--bg-primary); }",
            "::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: 4px; }",
            "::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }",
        ].join("\n");

        // ── Custom Element ──

        class HsDebugPanel extends HTMLElement {
            constructor() {
                super();
                this._hdb = null;
                this._logEntries = [];
                this._maxLog = 100;
                this._activeTab = "log";
                this._collapsed = false;
                this._errorCount = 0;
                this._consoleHistoryIdx = 0;
                this._consoleOldContent = null;
                this._consoleHistory = [];
                this._docListeners = [];
                this._stepHandler = null;
                this._doneHandler = null;
                this._dragState = null;
            }

            static get observedAttributes() {
                return ["max-log", "open", "position"];
            }

            connectedCallback() {
                if (!this._root) {
                    var shadow = this.attachShadow({ mode: "open" });
                    var style = document.createElement("style");
                    style.textContent = PANEL_CSS;
                    shadow.appendChild(style);

                    this._buildDOM(shadow);

                    this._root = shadow;
                    this._panel = shadow.querySelector(".app");

                    this._setupEventListeners();
                }

                this._setupDocumentListeners();

                panels.add(this);

                if (this.hasAttribute("max-log")) {
                    this._maxLog = parseInt(this.getAttribute("max-log"), 10) || 100;
                }

                this._addLogEntry("info", "Debug panel loaded", "hyperscript v" + (_hyperscript.version || "?"));
            }

            disconnectedCallback() {
                this._teardownDocumentListeners();
                panels.delete(this);
                if (this._hdb) {
                    this._hdb.offStep(this._stepHandler);
                }
            }

            attributeChangedCallback(name, oldVal, newVal) {
                if (name === "max-log") {
                    this._maxLog = parseInt(newVal, 10) || 100;
                }
            }

            _buildDOM(shadow) {
                // Structure mirrors htmx-devtools App.tsx: .app > .drag-header + .tab-bar + .app__content
                var app = document.createElement("div");
                app.className = "app";

                // Drag header (float-only addition, not in htmx-devtools)
                var dragHeader = document.createElement("div");
                dragHeader.className = "drag-header";

                var headerLeft = document.createElement("div");
                headerLeft.className = "drag-header__left";

                var dot = document.createElement("span");
                dot.className = "status-dot status-dot--success";
                headerLeft.appendChild(dot);

                var title = document.createElement("span");
                title.className = "drag-header__title";
                title.textContent = "_hyperscript";
                headerLeft.appendChild(title);

                var version = document.createElement("span");
                version.className = "drag-header__version";
                version.textContent = "hs " + (_hyperscript.version || "?");
                headerLeft.appendChild(version);

                var headerActions = document.createElement("div");
                headerActions.className = "drag-header__actions";

                var collapseBtn = document.createElement("button");
                collapseBtn.className = "toolbar__btn collapse-btn";
                collapseBtn.title = "Toggle panel";
                collapseBtn.textContent = "\u2015";
                headerActions.appendChild(collapseBtn);

                var closeBtn = document.createElement("button");
                closeBtn.className = "toolbar__btn close-btn";
                closeBtn.title = "Close panel";
                closeBtn.textContent = "\u2715";
                headerActions.appendChild(closeBtn);

                dragHeader.appendChild(headerLeft);
                dragHeader.appendChild(headerActions);
                app.appendChild(dragHeader);

                // Tab bar (htmx-devtools .tab-bar)
                var tabBar = document.createElement("div");
                tabBar.className = "tab-bar";
                var tabNames = ["log", "code", "context", "console"];
                var tabLabels = ["Log", "Code", "Context", "Console"];
                for (var i = 0; i < tabNames.length; i++) {
                    var tab = document.createElement("button");
                    tab.className = "tab-bar__tab" + (i === 0 ? " tab-bar__tab--active" : "");
                    tab.dataset.tab = tabNames[i];
                    tab.textContent = tabLabels[i];
                    tabBar.appendChild(tab);
                }
                var spacer = document.createElement("div");
                spacer.className = "tab-bar__spacer";
                tabBar.appendChild(spacer);

                var clearAllBtn = document.createElement("button");
                clearAllBtn.className = "toolbar__btn clear-log-btn";
                clearAllBtn.title = "Clear";
                clearAllBtn.textContent = "\u1D5EB";
                tabBar.appendChild(clearAllBtn);

                app.appendChild(tabBar);

                // Content area (htmx-devtools .app__content)
                var content = document.createElement("div");
                content.className = "app__content";

                // Log pane
                var logPane = document.createElement("div");
                logPane.className = "tab-pane active";
                logPane.dataset.pane = "log";

                var logCountBar = document.createElement("div");
                logCountBar.className = "tab-bar__info log-count";
                logCountBar.style.cssText = "padding:4px 8px;color:var(--text-muted);font-size:10px;border-bottom:1px solid var(--border)";
                logCountBar.textContent = "0 events";
                logPane.appendChild(logCountBar);

                var logList = document.createElement("div");
                logList.className = "log-list";
                logList.style.cssText = "flex:1;overflow-y:auto";
                logPane.appendChild(logList);

                content.appendChild(logPane);

                // Code pane
                var codePane = document.createElement("div");
                codePane.className = "tab-pane";
                codePane.dataset.pane = "code";

                var codeToolbar = document.createElement("div");
                codeToolbar.className = "toolbar";

                var continueBtn = document.createElement("button");
                continueBtn.className = "toolbar__btn continue-btn";
                continueBtn.disabled = true;
                continueBtn.title = "Continue";
                continueBtn.textContent = "\u23F5";
                codeToolbar.appendChild(continueBtn);

                var stepBtn = document.createElement("button");
                stepBtn.className = "toolbar__btn step-btn";
                stepBtn.disabled = true;
                stepBtn.title = "Step Over";
                stepBtn.textContent = "\u21B7";
                codeToolbar.appendChild(stepBtn);

                var stepOutBtn = document.createElement("button");
                stepOutBtn.className = "toolbar__btn step-out-btn";
                stepOutBtn.disabled = true;
                stepOutBtn.title = "Step Out";
                stepOutBtn.textContent = "\u21B5";
                codeToolbar.appendChild(stepOutBtn);

                codePane.appendChild(codeToolbar);

                var codeContainer = document.createElement("div");
                codeContainer.className = "code-container";
                var codePre = document.createElement("pre");
                codePre.className = "code-pre";
                codeContainer.appendChild(codePre);
                codePane.appendChild(codeContainer);

                content.appendChild(codePane);

                // Context pane
                var ctxPane = document.createElement("div");
                ctxPane.className = "tab-pane";
                ctxPane.dataset.pane = "context";
                content.appendChild(ctxPane);

                // Console pane
                var consolePane = document.createElement("div");
                consolePane.className = "tab-pane";
                consolePane.dataset.pane = "console";

                var consoleList = document.createElement("ul");
                consoleList.className = "console-list";
                consolePane.appendChild(consoleList);

                var consoleForm = document.createElement("form");
                consoleForm.className = "console-form";
                var consoleInput = document.createElement("input");
                consoleInput.type = "text";
                consoleInput.placeholder = "Evaluate expression\u2026";
                consoleInput.autocomplete = "off";
                consoleForm.appendChild(consoleInput);
                consolePane.appendChild(consoleForm);

                content.appendChild(consolePane);

                app.appendChild(content);
                shadow.appendChild(app);
            }

            // ── HDB Integration ──

            attachHdb(hdb, ctx) {
                this._hdb = hdb;

                var self = this;
                this._stepHandler = function () {
                    self._renderCodeTab();
                    self._renderContextTab();
                };
                this._doneHandler = function () {
                    if (self._hdb) self.detachHdb();
                };

                hdb.onStep(this._stepHandler);
                hdb.onDone(this._doneHandler);

                this._switchTab("code");
                this._updateDebugButtons(true);
                this._renderCodeTab();
                this._renderContextTab();

                var dot = this._root.querySelector(".status-dot");
                if (dot) { dot.classList.remove("status-dot--success"); dot.classList.add("status-dot--pending"); }

                if (this._collapsed) {
                    this._collapsed = false;
                    this._panel.classList.remove("collapsed");
                }

                this._addLogEntry("info", "Breakpoint hit", ctx.meta.feature ? ctx.meta.feature.displayName : "");
            }

            detachHdb() {
                if (this._hdb && this._stepHandler) {
                    this._hdb.offStep(this._stepHandler);
                }
                this._hdb = null;
                this._stepHandler = null;
                this._doneHandler = null;

                this._updateDebugButtons(false);

                var dot = this._root.querySelector(".status-dot");
                if (dot) { dot.classList.remove("status-dot--pending"); dot.classList.add("status-dot--success"); }

                var codePre = this._root.querySelector(".code-pre");
                if (codePre) {
                    codePre.textContent = "";
                    var empty = document.createElement("div");
                    empty.className = "empty-state";
                    empty.textContent = "No active breakpoint";
                    codePre.appendChild(empty);
                }

                var ctxPane = this._root.querySelector('[data-pane="context"]');
                if (ctxPane) {
                    ctxPane.textContent = "";
                    var ctxEmpty = document.createElement("div");
                    ctxEmpty.className = "empty-state";
                    ctxEmpty.textContent = "No active breakpoint";
                    ctxPane.appendChild(ctxEmpty);
                }

                this._addLogEntry("info", "Breakpoint released", "Execution resumed");
            }

            // ── Event Listeners ──

            _setupEventListeners() {
                var self = this;

                // Tab switching
                this._root.querySelector(".tab-bar").addEventListener("click", function (e) {
                    var tab = e.target.closest(".tab-bar__tab");
                    if (tab) self._switchTab(tab.dataset.tab);
                });

                // Collapse
                this._root.querySelector(".collapse-btn").addEventListener("click", function () {
                    self._collapsed = !self._collapsed;
                    self._panel.classList.toggle("collapsed", self._collapsed);
                });

                // Close
                this._root.querySelector(".close-btn").addEventListener("click", function () {
                    self.remove();
                });

                // Clear log
                this._root.querySelector(".clear-log-btn").addEventListener("click", function () {
                    self._logEntries = [];
                    self._errorCount = 0;
                    self._renderLogTab();
                    self._updateLogBadge();
                });

                // Debug buttons
                this._root.querySelector(".continue-btn").addEventListener("click", function () {
                    if (self._hdb) self._hdb.continueExec();
                });

                this._root.querySelector(".step-btn").addEventListener("click", function () {
                    if (self._hdb) self._hdb.stepOver();
                });

                this._root.querySelector(".step-out-btn").addEventListener("click", function () {
                    if (self._hdb) self._hdb.stepOut();
                });

                // Code skip buttons (delegated)
                this._root.querySelector(".code-container").addEventListener("click", function (e) {
                    var btn = e.target.closest(".skip-btn");
                    if (btn && self._hdb) {
                        var idx = parseInt(btn.dataset.cmd, 10);
                        self._hdb.skipTo(idx);
                    }
                });

                // Console form
                var consoleForm = this._root.querySelector(".console-form");
                var consoleInput = consoleForm.querySelector("input");

                consoleForm.addEventListener("submit", function (e) {
                    e.preventDefault();
                    var input = consoleInput.value.trim();
                    if (!input) return;

                    var result;
                    if (self._hdb) {
                        result = self._hdb.evaluateExpression(input);
                    } else {
                        try {
                            var parsed = _hyperscript.parse(input);
                            var output = parsed.execute ? parsed.execute(null) : parsed.evaluate(null);
                            result = { input: input, output: output };
                        } catch (err) {
                            result = { input: input, output: "[Error] " + err.message };
                        }
                    }

                    self._consoleHistory.push(input);
                    self._addConsoleEntry(result.input, result.output);
                    consoleInput.value = "";
                    self._consoleHistoryIdx = 0;
                    self._consoleOldContent = null;
                });

                consoleInput.addEventListener("keydown", function (e) {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    var history = self._hdb ? self._hdb.getConsoleHistory() : self._consoleHistory;
                    if (history.length === 0) return;

                    if (self._consoleOldContent === null) {
                        self._consoleOldContent = consoleInput.value;
                    }

                    if (e.key === "ArrowUp" && history.length > -self._consoleHistoryIdx) {
                        self._consoleHistoryIdx--;
                    } else if (e.key === "ArrowDown" && self._consoleHistoryIdx < 0) {
                        self._consoleHistoryIdx++;
                    }

                    consoleInput.value =
                        history[history.length + self._consoleHistoryIdx] || self._consoleOldContent;
                    e.preventDefault();
                });

                // Drag
                var header = this._root.querySelector(".drag-header");
                header.addEventListener("pointerdown", function (e) {
                    if (e.target.closest(".drag-header__actions")) return;
                    e.preventDefault();
                    var rect = self._panel.getBoundingClientRect();
                    self._dragState = {
                        startX: e.clientX,
                        startY: e.clientY,
                        origLeft: rect.left,
                        origTop: rect.top,
                    };

                    self.style.position = "fixed";
                    self.style.left = rect.left + "px";
                    self.style.top = rect.top + "px";
                    self.style.right = "auto";
                    self.style.bottom = "auto";

                    header.setPointerCapture(e.pointerId);
                });

                header.addEventListener("pointermove", function (e) {
                    if (!self._dragState) return;
                    var dx = e.clientX - self._dragState.startX;
                    var dy = e.clientY - self._dragState.startY;
                    self.style.left = self._dragState.origLeft + dx + "px";
                    self.style.top = self._dragState.origTop + dy + "px";
                });

                header.addEventListener("pointerup", function () {
                    self._dragState = null;
                });

                header.addEventListener("pointercancel", function () {
                    self._dragState = null;
                });
            }

            _setupDocumentListeners() {
                var self = this;

                var onException = function (e) {
                    var detail = e.detail || {};
                    var el = e.target;
                    var tag = el && el.tagName ? el.tagName.toLowerCase() : "?";
                    var id = el && el.id ? "#" + el.id : "";
                    self._errorCount++;
                    self._addLogEntry(
                        "exception",
                        "Error on <" + tag + id + ">",
                        detail.error ? detail.error.message || String(detail.error) : "Unknown error"
                    );
                    self._updateLogBadge();
                };

                var onLoad = function (e) {
                    if (!e.detail || !e.detail.hyperscript) return;
                    var el = e.target;
                    var tag = el && el.tagName ? el.tagName.toLowerCase() : "?";
                    var id = el && el.id ? "#" + el.id : "";
                    self._addLogEntry("load", "Script loaded", "<" + tag + id + ">");
                };

                var onHtmxLoad = function (e) {
                    var detail = e.detail || {};
                    var el = detail.elt;
                    var tag = el && el.tagName ? el.tagName.toLowerCase() : "?";
                    var id = el && el.id ? "#" + el.id : "";
                    self._addLogEntry("htmx", "htmx:load", "<" + tag + id + ">");
                };

                var onReady = function () {
                    self._addLogEntry("ready", "hyperscript:ready", "DOM processing complete");
                };

                document.addEventListener("exception", onException, true);
                document.addEventListener("load", onLoad, true);
                document.addEventListener("htmx:load", onHtmxLoad, true);
                document.addEventListener("hyperscript:ready", onReady, true);

                this._docListeners = [
                    ["exception", onException, true],
                    ["load", onLoad, true],
                    ["htmx:load", onHtmxLoad, true],
                    ["hyperscript:ready", onReady, true],
                ];
            }

            _teardownDocumentListeners() {
                for (var entry of this._docListeners) {
                    document.removeEventListener(entry[0], entry[1], entry[2]);
                }
                this._docListeners = [];
            }

            // ── Tab Management ──

            _switchTab(name) {
                this._activeTab = name;

                var tabs = this._root.querySelectorAll(".tab-bar__tab");
                for (var t of tabs) {
                    t.classList.toggle("tab-bar__tab--active", t.dataset.tab === name);
                }

                var panes = this._root.querySelectorAll(".tab-pane");
                for (var p of panes) {
                    p.classList.toggle("active", p.dataset.pane === name);
                }

                if (name === "log") {
                    this._renderLogTab();
                    this._errorCount = 0;
                    this._updateLogBadge();
                }
            }

            // ── Rendering ──

            _addLogEntry(type, title, detail) {
                var entry = {
                    type: type,
                    title: title,
                    detail: detail || "",
                    time: new Date(),
                };

                this._logEntries.unshift(entry);
                if (this._logEntries.length > this._maxLog) {
                    this._logEntries.length = this._maxLog;
                }

                if (this._activeTab === "log") {
                    this._renderLogTab();
                }
            }

            _renderLogTab() {
                var list = this._root.querySelector(".log-list");
                if (!list) return;

                var countBar = this._root.querySelector(".log-count");

                while (list.firstChild) {
                    list.removeChild(list.firstChild);
                }

                if (this._logEntries.length === 0) {
                    var empty = document.createElement("div");
                    empty.className = "empty-state";
                    var emptyTitle = document.createElement("div");
                    emptyTitle.className = "empty-state__title";
                    emptyTitle.textContent = "No events captured";
                    empty.appendChild(emptyTitle);
                    var emptyDesc = document.createElement("div");
                    emptyDesc.textContent = "Interact with the page to see hyperscript events here";
                    empty.appendChild(emptyDesc);
                    list.appendChild(empty);
                    if (countBar) countBar.textContent = "0 events";
                    return;
                }

                if (countBar) countBar.textContent = this._logEntries.length + " event" + (this._logEntries.length !== 1 ? "s" : "");

                for (var entry of this._logEntries) {
                    // Uses htmx-devtools .list-item pattern
                    var row = document.createElement("div");
                    row.className = "list-item";

                    var time = document.createElement("span");
                    time.className = "time";
                    time.textContent = formatTime(entry.time);
                    row.appendChild(time);

                    var typeBadge = document.createElement("span");
                    typeBadge.className = "verb-badge verb-badge--" + entry.type;
                    typeBadge.textContent = entry.type;
                    row.appendChild(typeBadge);

                    var detail = document.createElement("span");
                    detail.className = "detail-text";
                    detail.title = entry.detail;
                    detail.textContent = entry.title + (entry.detail ? " " + entry.detail : "");
                    row.appendChild(detail);

                    list.appendChild(row);
                }
            }

            _renderCodeTab() {
                var codePre = this._root.querySelector(".code-pre");
                if (!codePre || !this._hdb) return;

                var html = this._hdb.renderCode();
                if (html) {
                    // renderCode() returns trusted HTML built from AST internals
                    // with all source code segments passed through escapeHTML()
                    setTrustedHTML(codePre, html);
                    var current = codePre.querySelector(".current");
                    if (current) current.scrollIntoView({ block: "center", behavior: "smooth" });
                } else {
                    codePre.textContent = "";
                    var empty = document.createElement("code");
                    empty.className = "code-empty";
                    empty.textContent = "No source available";
                    codePre.appendChild(empty);
                }
            }

            _renderContextTab() {
                var pane = this._root.querySelector('[data-pane="context"]');
                if (!pane || !this._hdb) return;

                var ctx = this._hdb.getCtx();
                if (!ctx) {
                    pane.textContent = "";
                    var noCtx = document.createElement("div");
                    noCtx.className = "empty-state";
                    noCtx.textContent = "No context";
                    pane.appendChild(noCtx);
                    return;
                }

                var keys = Object.keys(ctx).filter(function (k) { return k !== "meta"; });
                if (keys.length === 0) {
                    pane.textContent = "";
                    var noVars = document.createElement("div");
                    noVars.className = "empty-state";
                    var noVarsTitle = document.createElement("div");
                    noVarsTitle.className = "empty-state__title";
                    noVarsTitle.textContent = "No variables in context";
                    noVars.appendChild(noVarsTitle);
                    pane.appendChild(noVars);
                    return;
                }

                pane.textContent = "";

                // Section header (htmx-devtools .detail-section pattern)
                var section = document.createElement("div");
                section.className = "detail-section";
                var sectionTitle = document.createElement("div");
                sectionTitle.className = "detail-section__title";
                sectionTitle.textContent = "Variables (" + keys.length + ")";
                section.appendChild(sectionTitle);
                pane.appendChild(section);

                // kv-table (htmx-devtools pattern)
                var kvTable = document.createElement("div");
                kvTable.className = "kv-table";
                kvTable.style.cssText = "flex:1;overflow-y:auto";

                for (var key of keys) {
                    var row = document.createElement("div");
                    row.className = "kv-table__row";

                    var keyEl = document.createElement("span");
                    keyEl.className = "kv-table__key";
                    keyEl.textContent = key;
                    row.appendChild(keyEl);

                    var valEl = document.createElement("span");
                    valEl.className = "kv-table__value";
                    try {
                        // prettyPrint returns trusted HTML from internal AST data
                        // with user-visible strings escaped via escapeHTML()
                        setTrustedHTML(valEl, prettyPrint(ctx[key]));
                    } catch (e) {
                        valEl.textContent = "[Error reading value]";
                    }
                    row.appendChild(valEl);
                    kvTable.appendChild(row);
                }

                pane.appendChild(kvTable);
            }

            _addConsoleEntry(input, output) {
                var list = this._root.querySelector(".console-list");
                if (!list) return;

                var isError = typeof output === "string" && output.indexOf("[Error]") === 0;
                var li = document.createElement("li");
                li.className = "console-entry";

                var inputCode = document.createElement("code");
                inputCode.className = "input";
                inputCode.textContent = input;
                li.appendChild(inputCode);

                var outputSamp = document.createElement("samp");
                outputSamp.className = "output" + (isError ? " error" : "");
                // prettyPrint output uses trusted HTML from internal hyperscript data
                setTrustedHTML(outputSamp, prettyPrint(output));
                li.appendChild(outputSamp);

                list.appendChild(li);
                li.scrollIntoView({ block: "end", behavior: "smooth" });
            }

            _updateDebugButtons(enabled) {
                var btns = this._root.querySelectorAll(".continue-btn, .step-btn, .step-out-btn");
                for (var btn of btns) {
                    btn.disabled = !enabled;
                }
            }

            _updateLogBadge() {
                var logTab = this._root.querySelector('.tab-bar__tab[data-tab="log"]');
                if (!logTab) return;

                var badge = logTab.querySelector(".badge");
                if (!badge) {
                    badge = document.createElement("span");
                    badge.className = "badge badge--error hidden";
                    logTab.appendChild(badge);
                }

                if (this._errorCount > 0 && this._activeTab !== "log") {
                    badge.textContent = String(this._errorCount);
                    badge.classList.remove("hidden");
                } else {
                    badge.classList.add("hidden");
                }
            }
        }

        // ── Register and Auto-inject ──

        customElements.define("hs-debug-panel", HsDebugPanel);

        function autoInject() {
            if (!document.querySelector("hs-debug-panel")) {
                document.body.appendChild(document.createElement("hs-debug-panel"));
            }
        }

        if (document.readyState !== "loading") {
            autoInject();
        } else {
            document.addEventListener("DOMContentLoaded", autoInject);
        }
    };
});
