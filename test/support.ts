import * as path from 'path';
import { fromObservable, Model, notify } from '../src/lib/model';
import { Updatable } from '../src/lib/updatable';
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';

let chai = require("chai");
let chaiAsPromised = require("chai-as-promised");

chai.should();
chai.use(chaiAsPromised);

@notify('foo', 'bar')
export class TestClass extends Model {
  someSubject: Subject<number>;
  foo: Number;
  bar: Number;
  baz: Number;
  updatableFoo: Updatable<number>;
  @fromObservable derived: number;
  @fromObservable subjectDerived: number;

  get explodingProperty(): TestClass {
    throw new Error('Kaplowie');
  }

  constructor() {
    super();
    this.updatableFoo = new Updatable(() => Observable.of(6));
    this.someSubject = new Subject();

    Observable.of(42).toProperty(this, 'derived');
    this.someSubject
      .map((x) => x * 10)
      .startWith(0)
      .toProperty(this, 'subjectDerived');
  }
}

export async function waitForPropertyChange(viewModel: Model, propName?: string) {
  await viewModel.changed
    .filter(({ property }) => propName ? property === propName : true)
    .take(1)
    .toPromise();
}

before(function() {
  // NB: We do this so that coverage is more accurate
  this.timeout(30 * 1000);
  require('../src/slack-app');
});

after(() => {
  if (!('__coverage__' in window)) {
    if (process.env.BABEL_ENV === 'test') throw new Error("electron-compile didn't generate coverage info!");
    return;
  }

  console.log('Writing coverage information...');

  const { Reporter, Collector } = require('istanbul');

  const coll = new Collector();
  coll.add(window.__coverage__);

  const reporter = new Reporter(null, path.join(__dirname, '..', 'coverage'));
  reporter.addAll(['text-summary', 'lcovonly']);

  return new Promise((res) => {
    reporter.write(coll, true, res);
  });
});

export const {expect, assert} = chai;