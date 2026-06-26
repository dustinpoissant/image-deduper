// window.api holds built-ins; custom api/*.js are reached via api.call(name,...).
export default new Proxy({}, {
  get(_t, prop) {
    if (prop in window.api && typeof window.api[prop] !== 'undefined') return window.api[prop];
    return (...args) => window.api.call(prop, ...args);
  }
});
