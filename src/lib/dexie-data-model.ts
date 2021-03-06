import { AsyncSubject } from 'rxjs/AsyncSubject';

import Dexie from 'dexie';
import { asyncMap } from './promise-extras';
import { User, ChannelBase, Message } from './models/api-shapes';
import { Pair } from './utils';
import { Api } from './models/slack-api';

import './standard-operators';
import 'request-idle-polyfill';
import { MessageKey } from './store';

//const d = require('debug')('trickline:dexie-data-model');
const dn = require('debug')('trickline-noisy:dexie-data-model');

const VERSION = 1;

export interface DeferredPutItem<T, TKey> {
  item: T;
  key: TKey;
  completion: AsyncSubject<void>;
}

export interface DeferredGetItem<T, TKey> {
  key: TKey;
  completion: AsyncSubject<T>;
}

declare module 'dexie' {
  module Dexie {
    interface Table<T, Key> {
      deferredPut: ((item: T, key: Key) => Promise<void>);
      deferredGet: ((key: Key, database: Dexie) => Promise<T & { token: string }>);
      idlePutHandle: NodeJS.Timer | null;
      idleGetHandle: number | null;
      deferredPuts: DeferredPutItem<T & Api, Key>[];
      deferredGets: DeferredGetItem<T, Key>[];
    }
  }
}

function deferredPut<T, Key>(this: Dexie.Table<T, Key>, item: T & Api, key: Key): Promise<void> {
  let newItem = { item, key, completion: new AsyncSubject<void>() };
  newItem.item = Object.assign({}, newItem.item);

  let createIdle = () => window.requestIdleCallback(async deadline => {
    while (deadline.timeRemaining() > 5/*ms*/) {
      // TODO: This would be cooler if it recognized duplicate IDs and threw out the older
      // one (i.e. you update channel.topic and channel.name in the same batch, so we really
      // only need to write the newer one)
      let itemsToAdd = this.deferredPuts.slice(0, 128).map(x => {
        if (x.item.api) {
          x.item.token = x.item.api.token();
          x.item.api = null;
        }

        return x;
      });

      if (itemsToAdd.length < 1) break;

      await this.bulkPut(itemsToAdd.map(x => x.item))
        .then(
          () => itemsToAdd.forEach(x => { dn(`Actually wrote ${JSON.stringify(x.key)}!`); x.completion.next(undefined); x.completion.complete(); }),
          (e) => itemsToAdd.forEach(x => x.completion.error(e)));

      this.deferredPuts.splice(0, itemsToAdd.length);
    }

    if (this.deferredPuts.length > 0) {
      this.idlePutHandle = createIdle();
    } else {
      this.idlePutHandle = null;
    }
  });

  dn(`Queuing new item for write! ${JSON.stringify(newItem.key)}`);
  this.deferredPuts = this.deferredPuts || [];
  this.deferredPuts.push(newItem);

  if (!this.idlePutHandle) {
    this.idlePutHandle = createIdle();
  }

  return newItem.completion.toPromise();
}

function deferredGet<T, Key>(this: Dexie.Table<T, Key>, key: Key, database: Dexie): Promise<T> {
  let newItem = { key, completion: new AsyncSubject<T>() };

  let createIdle = () => window.requestAnimationFrame(async () => {
    let itemsToGet = this.deferredGets;
    this.deferredGets = [];

    try {
      await database.transaction('r', this, () => {
        return asyncMap(itemsToGet, (x) => {
          // First, search pending writes to see if we're about to save this
          dn(`Attempting to fetch ${x.key}!`);

          let pending = (this.deferredPuts || []).find(y => y.key === x.key);
          if (pending) {
            dn(`Early-completing ${key}!`);

            // NB: We need to do a shallow clone here because otherwise at some point,
            // api will be replaced by 'token' on this pending object, thereby trolling
            // the caller
            x.completion.next(Object.assign({}, pending.item));
            x.completion.complete();
            return Promise.resolve();
          }

          return this.get(x.key).then(result => {
            x.completion.next(result!);
            x.completion.complete();
          }, (e: Error) => x.completion.error(e));
        }, 32);
      });
    } finally {
      this.idleGetHandle = null;
    }

    if (this.deferredGets.length > 0) {
      this.idleGetHandle = createIdle();
    }
  });

  this.deferredGets = this.deferredGets || [];
  this.deferredGets.push(newItem);

  if (!this.idleGetHandle) {
    this.idleGetHandle = createIdle();
  }

  return newItem.completion.toPromise();
}

export class DataModel extends Dexie {
  users: Dexie.Table<User, string>;
  channels: Dexie.Table<ChannelBase, string>;
  messages: Dexie.Table<Message, MessageKey>;
  keyValues: Dexie.Table<Pair<string, string>, string>;

  constructor() {
    super('SparseMap');

    this.version(VERSION).stores({
      users: 'id',
      channels: 'id',
      keyValues: 'Key',
      messages: '[channel+ts]'
    });

    // NB: They'll all share the same prototype, no need to bolt this onto
    // every instance
    Object.getPrototypeOf(this.users).deferredPut = deferredPut;
    Object.getPrototypeOf(this.users).deferredGet = deferredGet;
  }
}

