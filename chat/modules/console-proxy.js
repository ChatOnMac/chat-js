// Console proxy, modified from livecodes
// typeOf modified from https://github.com/alexindigo/precise-typeof/blob/master/index.js
const typeOf = (obj) => {
    function isElement(o) {
        return typeof HTMLElement === 'object'
            ? o instanceof HTMLElement
            : o &&
            typeof o === 'object' &&
            o !== null &&
            o.nodeType === 1 &&
            typeof o.nodeName === 'string';
    }
    function isNode(o) {
        return typeof Node === 'object'
            ? o instanceof Node
            : o &&
            typeof o === 'object' &&
            typeof o.nodeType === 'number' &&
            typeof o.nodeName === 'string';
    }
    function isDocument(o) {
        return Object.prototype.toString.call(o) === '[object HTMLDocument]';
    }
    function isWindow(o) {
        return Object.prototype.toString.call(o) === '[object Window]';
    }

    const stamp = Object.prototype.toString.call(obj);

    if (obj === undefined) return 'undefined';
    if (obj === null) return 'null';

    if (isWindow(obj)) return 'window';
    if (isDocument(obj)) return 'document';
    if (isElement(obj)) return 'element';
    if (isNode(obj)) return 'node';

    if (
        obj.constructor &&
        typeof obj.constructor.isBuffer === 'function' &&
        obj.constructor.isBuffer(obj)
    ) {
        return 'buffer';
    }

    if (typeof window === 'object' && obj === window) return 'window';
    if (typeof global === 'object' && obj === global) return 'global';

    if (typeof obj === 'number' && isNaN(obj)) return 'nan';
    if (typeof obj === 'object' && stamp === '[object Number]' && isNaN(obj)) return 'nan';

    if (typeof obj === 'object' && stamp.substr(-6) === 'Event]') return 'event';
    if (stamp.substr(0, 12) === '[object HTML') return 'element';
    if (stamp.substr(0, 12) === '[object Node') return 'node';

    // last resort
    const type = stamp.match(/\[object\s*([^\]]+)\]/);
    if (type) return type[1].toLowerCase();

    return 'object';
};
function consoleArgs(args) {
    return args.map((arg) => {
        switch (typeOf(arg)) {
            case 'window':
            case 'function':
            case 'date':
            case 'symbol':
                return { type: typeOf(arg), content: arg.toString() };
            case 'document':
                return { type: typeOf(arg), content: arg.documentElement.outerHTML };
            case 'element':
                return { type: typeOf(arg), content: arg.outerHTML };
            case 'node':
                return { type: typeOf(arg), content: arg.textContent };
            case 'array':
                return { type: typeOf(arg), content: arg.map((x) => consoleArgs([x])[0].content) };
            case 'object':
                return {
                    type: typeOf(arg),
                    content: Object.keys(arg).reduce(
                        (acc, key) => {
                            console.log(key);
                            //var objectsVisited = objectsVisited || new Set();
                            //if (objectsVisited && objectsVisited.has(typeOf(arg))) {
                            //    return "[...]";
                            //}
                            //objectsVisited.add(typeOf(arg));
                            const toVisit = arg[key];
                            if (typeOf(toVisit) === 'object') {
                                return "[Object]";
                            }
                            return { ...acc, [key]: consoleArgs([arg[key]])[0].content };
                        },
                        {},
                    ),
                };
            case 'error':
                return {
                    type: typeOf(arg),
                    content: arg.constructor.name + ': ' + arg.message,
                };
        }
        try {
            return { type: 'other', content: structuredClone(arg) };
        } catch {
            return { type: 'other', content: String(arg) };
        }
    });
};
const proxyConsole = () => {
    window.console = new Proxy(console, {
        get(target, method) {
            return function (...args) {
                if (!(method in target)) {
                    const msg = `Uncaught TypeError: console.${String(method)} is not a function`;
                    target.error(msg);
                    window.webkit.messageHandlers.consoleMessage.postMessage({ method: 'error', args: consoleArgs([msg]) });
                    return;
                }
                (target[method])(...args);
                window.webkit.messageHandlers.consoleMessage.postMessage({ method, args: consoleArgs(args) });
            };
        },
    });

    window.addEventListener('error', (error) => {
        window.webkit.messageHandlers.consoleMessage.postMessage({ method: 'error', args: consoleArgs([error.message]) });
    });
};

export { proxyConsole };
