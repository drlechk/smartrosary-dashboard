const elements = new Map();
function createElement(tag){
  const el = {
    tag,
    style: {},
    dataset: {},
    children: [],
    classList: {
      list: new Set(),
      add(c){ this.list.add(c); },
      remove(c){ this.list.delete(c); },
      contains(c){ return this.list.has(c); }
    },
    appendChild(child){ this.children.push(child); child.parentNode = this; },
    querySelector(sel){
      if (sel === '.bar') return this.children.find(ch => ch.className === 'bar') || null;
      return null;
    },
    set hidden(v){ this._hidden = !!v; },
    get hidden(){ return !!this._hidden; },
    set className(v){ this._className = v; },
    get className(){ return this._className; }
  };
  return el;
}

const document = {
  getElementById(id){ return elements.get(id) || null; },
  createElement(tag){
    const el = createElement(tag);
    if (tag === 'div') el.className = '';
    return el;
  },
  body: {
    appendChild(el){ /* noop */ }
  }
};

global.document = document;

global.performance = { now: () => Date.now() };

global.window = { getComputedStyle: () => ({}) };

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: '', platform: '', maxTouchPoints: 0 },
  configurable: true
});

const statusEl = createElement('div');
statusEl.id = 'status';
const progEl = createElement('div');
progEl.id = 'globalProg';
elements.set('status', statusEl);
elements.set('globalProg', progEl);

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

global.setTimeout = (fn, ms) => { fn(); return 0; };
global.clearTimeout = () => {};

global.setInterval = (fn, ms) => { return setTimeout(fn, ms); };
global.clearInterval = () => {};

const utils = await import('./js/utils.js');

utils.globalProgressStart('Test', 100);
utils.globalProgressSet(50);
console.log('width after set', progEl.querySelector('.bar').style.width);
console.log('active agg', utils.progAggregateActive());

utils.progAggregateStart([{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }]);
utils.progAggregateSet('a', 20);
utils.progAggregateSet('b', 0);
console.log('agg width', progEl.querySelector('.bar').style.width);
console.log('active agg2', utils.progAggregateActive());

utils.progAggregateDone();
console.log('active after done', utils.progAggregateActive());

utils.globalProgressStart('Standalone', 100);
utils.globalProgressSet(30);
console.log('width after standalone', progEl.querySelector('.bar').style.width);
