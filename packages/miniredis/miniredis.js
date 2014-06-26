// exported symbol
Miniredis = {};

var throwNotImplementedError = function (cb) {
  var err =
    new Error("The called method is not available in miniredis implementation");
  callInCallbackOrThrow(err, cb);
};

var throwIncorrectKindOfValueError = function (cb) {
  // XXX should be a special type of error "WRONGTYPE"
  var err =
    new Error("Operation against a key holding the wrong kind of value");
  callInCallbackOrThrow(err, cb);
};

// An abstract represtation of a set of keys matching PATTERN
Miniredis.Cursor = function (redisStore, pattern) {
  var self = this;
  self.redisStore = redisStore;
  self.pattern = pattern;
};

// XXX Not clear if we should forward these or just use the RedisStore
_.each(['keys', 'hgetall', 'hmset', 'hincrby', 'del'], function (name) {
  Miniredis.Cursor.prototype[name] = function (/* arguments */) {
    var self = this;
    var args = _.toArray(arguments);
    return self.redisStore[name].apply(self.redisStore, args);
  }
});

// returns the position where x should be inserted in a sorted array
var insPos = function (arr, x) {
  var l = 0, r = arr.length - 1;
  while (l <= r) {
    var m = (l + r) >> 1;
    if (arr[m] <= x)
      l = m + 1;
    else
      r = m - 1;
  }

  return l;
};

// returns added/changed/removed callbacks which call the passed ordered
// callbacks addedAt/changedAt/removedAt/movedTo
var translateToOrderedCallbacks = function (orderedCallbacks) {
  var queryResult = [];
  return {
    added: function (doc) {
      var pos = insPos(queryResult, doc._id);
      var before = queryResult[pos];
      queryResult.splice(pos, 0, doc._id);
      orderedCallbacks.addedAt && orderedCallbacks.addedAt(doc, pos, before);
    },
    changed: function (newDoc, oldDoc) {
      var pos = insPos(queryResult, newDoc._id) - 1;
      orderedCallbacks.changedAt && orderedCallbacks.changedAt(newDoc, oldDoc, pos);
    },
    removed: function (doc) {
      var pos = insPos(queryResult, doc._id) - 1;
      queryResult.splice(pos, 1);
      orderedCallbacks.removedAt && orderedCallbacks.removedAt(doc, pos);
    }
  };
};

// returns added/changed/removed/addedAt callbacks which call the passed
// added/changed/removed/addedAt/changedAt/removedAt callbacks within
// observeChanges API
var translateToChangesCallbacks = function (changesCallbacks) {
  var newCallbacks = {};

  if (changesCallbacks.added)
    newCallbacks.added = function (doc) {
      var id = doc._id;
      delete doc._id;
      changesCallbacks.added(id, doc);
    };
  if (changesCallbacks.addedAt)
    newCallbacks.addedAt = function (doc, atIndex, before) {
      var id = doc._id;
      delete doc._id;
      changesCallbacks.addedBefore(id, doc, before);
    };

  var changedCallback = function (newDoc, oldDoc) {
    var id = newDoc._id;
    delete newDoc._id;
    // effectively the diff document is just {value} doc, as there is always
    // a single top-level field with the value
    changesCallbacks.changed(id, newDoc);
  };
  if (changesCallbacks.changed)
    newCallbacks.changed = changedCallback;
  if (changesCallbacks.changedAt)
    newCallbacks.changedAt = changedCallback;

  var removedCallback = function (doc) {
    changesCallbacks.removed(doc._id);
  };
  if (changesCallbacks.removed)
    newCallbacks.removed = removedCallback;
  if (changesCallbacks.removedAt)
    newCallbacks.removedAt = removedCallback;

  return newCallbacks;
};

_.extend(Miniredis.Cursor.prototype, {
  fetch: function () {
    var self = this;
    return self.redisStore.patternFetch(self.pattern);
  },
  count: function () {
    var self = this;
    // XXX Inefficient
    return self.fetch().length;
  },
  observe: function (callbacks) {
    var self = this;

    if (callbacks.addedAt || callbacks.changedAt || callbacks.removedAt || callbacks.movedTo) {
      return self.observe(translateToOrderedCallbacks(callbacks));
    }

    var observeRecord = _.extend({ pattern: self.pattern }, callbacks);
    var redisStore = self.redisStore;
    redisStore.observes.push(observeRecord);

    _.each(redisStore.patternFetch(self.pattern), function (kv) {
      callbacks.added && callbacks.added({ _id: kv.key, value: kv.value  });
    });

    return {
      stop: function () {
        redisStore.observes = _.filter(redisStore.observes, function (obs) {
          return obs !== observeRecord;
        });
      }
    };
  },
  observeChanges: function (callbacks) {
    var self = this;

    if (callbacks.addedBefore || callbacks.movedBefore) {
      return self.observe(translateToChangesCallbacks(translateToOrderedCallbacks(callbacks)));
    }

    return self.observe(translateToChangesCallbacks(callbacks));
  }
});

// A main store class
Miniredis.RedisStore = function () {
  var self = this;

  // main key-value storage
  self._kv = new IdMap(EJSON.stringify, EJSON.parse);
  // fine-grained reactivity per key
  self._keyDependencies = {};
  // fine-grained reactivity per non-trivial pattern
  self._patternDependencies = {};
  // originals saved in-between calls to saveOriginals and
  // retrieveOriginals
  self._savedOriginals = null;
  // list of observes on cursors
  self.observes = [];

  // True when observers are paused and we should not send callbacks.
  self.paused = false;
};

// Pause the observers. No callbacks from observers will fire until
// 'resumeObservers' is called.
Miniredis.RedisStore.prototype.pauseObservers = function () {
  var self = this;
  // XXX pauseObservers fails silenty if nested?
  // No-op if already paused.
  if (self.paused)
   return;

  // Set the 'paused' flag such that new observer messages don't fire.
  self.paused = true;

  // Take a snapshot of the query results
  self._kv = new CowIdMap(self._kv);
};

// Resume the observers. Observers immediately receive change
// notifications to bring them to the current state of the
// database. Note that this is not just replaying all the changes that
// happened during the pause, it is a smarter 'coalesced' diff.
Miniredis.RedisStore.prototype.resumeObservers = function () {
  var self = this;
  // No-op if not paused.
  if (! self.paused)
   return;

  // Unset the 'paused' flag. Make sure to do this first, otherwise
  // observer methods won't actually fire when we trigger them.
  self.paused = false;

  // Diff the current results against the snapshot and send to observers.
  self._kv._diffQueryChanges(_.bind(self._notifyObserves, self));

  // XXX Should we just always use a CowIdMap?
  self._kv = self._kv.flatten();

  // XXX Do we need observeQueue (should we put it into a common class)
  //self._observeQueue.drain();
};

var callInCallbackAndReturn = function (res, cb) {
  cb && Meteor.defer(function () { cb(null, res); });
  return res;
};

var callInCallbackOrThrow = function (err, cb) {
  if (cb) cb(err);
  else throw err;
};

var maybePopCallback = function (args) {
  return _.isFunction(_.last(args)) ? args.pop() : undefined;
};

_.extend(Miniredis.RedisStore.prototype, {
  // -----
  // convinience wrappers
  // -----
  _keyDep: function (key) {
    var self = this;

    if (! self._keyDependencies[key])
      self._keyDependencies[key] = new Deps.Dependency();

    if (Deps.active) {
      // for future clean-up
      Deps.onInvalidate(function () {
        self._tryCleanUpKeyDep(key);
      });
    }

    return self._keyDependencies[key];
  },
  _has: function (key) {
    var self = this;
    self._keyDep(key).depend();
    return self._kv.has(key);
  },
  _get: function (key) {
    var self = this;
    self._keyDep(key).depend();
    return self._kv.get(key);
  },
  _set: function (key, value) {
    var self = this;
    var oldValue = self._kv.has(key) ? self._kv.get(key) : undefined;
    self._kv.set(key, value);

    self._saveOriginal(key, oldValue);
    if (!self.paused && oldValue !== value) {
      if (oldValue === undefined) {
        self._notifyObserves(key, 'added', value);
      } else {
        self._notifyObserves(key, 'changed', value, oldValue);
      }
      // XXX: Redis keyspace notifications don't really differentiate between added vs changed...
      self._notifyObserves(key, 'updated', value);
    }
  },

  _remove: function (key) {
    var self = this;
    if (! self._kv.has(key))
      return;
    var oldValue = self._kv.get(key);
    self._saveOriginal(key, oldValue);
    self._kv.remove(key);
    if (!self.paused)
      self._notifyObserves(key, 'removed', oldValue);
  },

  _tryCleanUpKeyDep: function (key) {
    var self = this;
    if (self._keyDependencies[key] && ! self._keyDependencies[key].hasDependents())
      delete self._keyDependencies[key];
  },

  _notifyObserves: function (key, event, value, oldValue) {
    var self = this;

    self._keyDep(key).changed();
    if (event === "removed") {
      self._tryCleanUpKeyDep(key);
    }

    if (event !== "changed") {
      _.each(self._patternDependencies, function (dep, pattern) {
        if (key.match(patternToRegexp(pattern))) {
          dep.changed();
        }
      });
    }

    _.each(self.observes, function (obs) {
      if (! key.match(patternToRegexp(obs.pattern)))
        return;
      if (event === "changed") {
        obs[event] && obs[event]({ _id: key, value: value },
                                 { _id: key, value: oldValue });
      } else if (event === "updated") {
        obs[event] && obs[event]({ _id: key, value: value});
      } else {
        obs[event] && obs[event]({ _id: key, value: value });
      }
    });
  },

  _drop: function () {
    var self = this;
    self._kv.forEach(function (value, key) {
      self._remove(key);
    });
  },

  // -----
  // main interface built on top of Redis
  // -----

  call: function (method/*, args */) {
    var self = this;
    var args = _.toArray(arguments).slice(1);

    return self[method.toLowerCase()].apply(self, args);
  },

  patternFetch: function (pattern, cb) {
    var self = this;
    var res = [];
    var thrown = false;

    self._kv.forEach(function (value, key) {
      if (thrown || ! key.match(patternToRegexp(pattern)))
        return;
      self._keyDep(key).depend();

      if (_.isString(value))
        res.push({ key: key, value: value });
      else if (_.isObject(value))
        res.push({ key: key, value: value.toArray() });
      else {
        callInCallbackOrThrow(new Error("Unknown type"));
        thrown = true;
      }
    });

    if (thrown) return;

    if (! self._patternDependencies[pattern])
      self._patternDependencies[pattern] = new Deps.Dependency();
    self._patternDependencies[pattern].depend();

    if (Deps.active) {
      Deps.onInvalidate(function (c) {
        if (c.stopped)
          delete self._patternDependencies[pattern];
      });
    }

    return callInCallbackAndReturn(res, cb);
  },

  // Returns a Cursor
  matching: function (pattern) {
    var self = this;
    var c = new Miniredis.Cursor(self, pattern);
    return c;
  },

  // -----
  // implementing the contract of a data store
  // -----
  saveOriginals: function () {
    var self = this;
    if (self._savedOriginals)
      throw new Error("Called saveOriginals twice without retrieveOriginals");
    self._savedOriginals = new IdMap(EJSON.stringify, EJSON.parse);
  },

  retrieveOriginals: function () {
    var self = this;
    if (!self._savedOriginals)
      throw new Error("Called retrieveOriginals without saveOriginals");

    var originals = self._savedOriginals;
    self._savedOriginals = null;
    return originals;
  },

  _saveOriginal: function (key, value) {
    var self = this;
    if (! self._savedOriginals || self._savedOriginals.has(key))
      return;
    self._savedOriginals.set(key, value && { _id: key, value: value }); // XXX need to deep clone value?
  },

  // -----
  // general operators on keys
  // -----

  del: function (/* args */) {
    var self = this;
    var removedCount = 0;
    var args = _.toArray(arguments);
    var cb = maybePopCallback(args);
    _.each(args, function (key) {
      if (self._has(key)) {
        removedCount++;
        self._remove(key);
      }
    });

    return callInCallbackAndReturn(removedCount, cb);
  },
  exists: function (key, cb) {
    var self = this;
    var res = self._has(key) ? 1 : 0;
    return callInCallbackAndReturn(res, cb);
  },
  keys: function (pattern, cb) {
    if (! pattern)
      throw new Error("Wrong number of arguments for 'keys' command");
    var self = this;
    var res = _.pluck(self.matching(pattern).fetch(), 'key');
    return callInCallbackAndReturn(res, cb);
  },
  randomkey: function (cb) {
    var self = this;
    var res = Random.choice(_.keys(self._kv));
    return callInCallbackAndReturn(res, cb);
  },
  rename: function (key, newkey, cb) {
    if (key === newkey) {
      callInCallbackOrThrow(
        new Error("Source and destination objects are the same"));
      return;
    }

    var self = this;

    if (! self._has(key)) {
      callInCallbackOrThrow(new Error("No such key"));
      return;
    }

    var val = self._get(key);
    self._remove(key);
    self._set(newkey, val);

    return callInCallbackAndReturn(undefined, cb);
  },
  renamenx: function (key, newkey, cb) {
    var self = this;
    var res;

    if (self._has(newkey)) {
      res = 0;
    } else {
      self.rename(key, newkey);
      res = 1;
    }

    return callInCallbackAndReturn(res, cb);
  },
  sort: function (cb) {
    // This is a non-trivial operator that requires more thought on the design
    // and implementation. We probably want to implement this as it is the only
    // querying mechanism.
    throwNotImplementedError(cb);
  },
  type: function (key, cb) {
    var self = this;
    var type;

    // for unset keys the return value is "none"
    if (! self._has(key)) {
      type = "none";
    } else {
      var val = self._get(key);
      type = _.isString(val) ? "string" : val.type();
    }

    return callInCallbackAndReturn(type, cb);
  },

  // -----
  // operators on strings
  // -----

  append: function (key, value, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : "";

    if (! _.isString(val)) {
      throwIncorrectKindOfValueError(cb);
      return;
    }

    val += value;
    self._set(key, val);

    return callInCallbackAndReturn(val.length, cb);
  },
  decr: function (key, cb) {
    var self = this;
    self.decrby(key, 1);
    callInCallbackAndReturn(undefined, cb);
  },
  decrby: function (key, decrement, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : "0";

    if (! _.isString(val)) {
      throwIncorrectKindOfValueError(cb);
      return;
    }

    // cast to integer
    var newVal = val |0;

    if (val !== newVal.toString()) {
      callInCallbackOrThrow(
        new Error("Value is not an integer or out of range"));
      return;
    }

    self._set(key, (newVal - decrement).toString());

    return callInCallbackAndReturn(undefined, cb);
  },
  get: function (key, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : null;
    if (val !== null && ! _.isString(val)) {
      throwIncorrectKindOfValueError(cb);
      return;
    }
    // Mirror mongo behaviour: missing get returns undefined
    if (val === null) {
      val = undefined;
    }

    return callInCallbackAndReturn(val, cb);
  },
  getrange: function (key, start, end, cb) {
    start = start || 0;
    end = end || 0;

    var self = this;
    var val = self._has(key) ? self._get(key) : "";

    if (! _.isString(val))
      throwIncorrectKindOfValueError(cb);
    if (val === "")
      return callInCallbackAndReturn("", cb);

    var len = val.length;
    var normalizedBounds = normalizeBounds(start, end, len);
    start = normalizedBounds.start;
    end = normalizedBounds.end;

    if (end < start)
      return callInCallbackAndReturn("", cb);

    return callInCallbackAndReturn(val.substr(start, end - start + 1), cb);
  },
  getset: function (key, value, cb) {
    var self = this;
    var val = self.get(key);
    self.set(key, value.toString());
    return callInCallbackAndReturn(val);
  },
  incr: function (key, cb) {
    var self = this;
    return self.incrby(key, 1, cb);
  },
  incrby: function (key, increment, cb) {
    var self = this;
    return self.decrby(key, -increment, cb);
  },
  incrbyfloat: function (key, increment, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : "0";

    if (! _.isString(val))
      throwIncorrectKindOfValueError();

    // cast to float
    var newVal = parseFloat(val);

    if (isNaN(newVal))
      throw new Error("Value is not a valid float");

    self._set(key, (newVal + increment).toString());
    return callInCallbackAndReturn(undefined, cb);
  },
  mget: function (/* args */) {
    var self = this;
    var args = _.toString(arguments);
    var cb = maybePopCallback(args);
    var res = _.map(args, function (key) {
      return self.get(key);
    });

    callInCallbackAndReturn(res, cb);
  },
  mset: function (/* args */) {
    var self = this;
    var args = _.toString(arguments);
    var cb = maybePopCallback(args);

    for (var i = 0; i < args.length; i += 2) {
      var key = args[i];
      var value = args[i + 1];
      self.set(key, value);
    }

    return callInCallbackAndReturn(undefined, cb);
  },
  msetnx: function (/* args */) {
    var self = this;
    var args = _.toString(arguments);
    var cb = maybePopCallback(args);
    var res;

    if (_.all(args, function (key, i) {
      return (i % 2 === 1) || self._has(key);
    })) {
      self.mset.apply(self, args);
      res = 1;
    } else {
      res = 0;
    }

    return callInCallbackAndReturn(res, cb);
  },
  set: function (key, value, cb) {
    var self = this;
    self._set(key, value.toString());
    return callInCallbackAndReturn("OK", cb);
  },
  setex: function (key, expiration, value, cb) {
    // We rely on the server to do our expirations
    var self = this;
    return self.set(key, value, cb);
  },
  setnx: function (key, value, cb) {
    var self = this;
    if (self._has(key))
      return callInCallbackAndReturn(0, cb);
    self.set(key, value);
    return callInCallbackAndReturn(1, cb);
  },
  setrange: function (key, offset, value, cb) {
    // We probably should have an implementation for this one but it requires a
    // bit more thinking on how do we zero pad the string.
    throwNotImplementedError(cb);
  },
  strlen: function (key, cb) {
    var self = this;
    var val = self.get(key);
    var len = val ? val.length : 0;
    return callInCallbackAndReturn(len, cb);
  },

  // -----
  // operators on hashes
  // -----

  hgetall: function (key, cb) {
    var self = this;
    if (!self._has(key)) {
      return undefined;
    }
    var val = self._get(key);
    if (! _.isObject(val))
      throwIncorrectKindOfValueError();
    return EJSON.clone(val);
  },

  hmset: function (key, o) {
    var self = this;
    if (! _.isObject(o))
      throwIncorrectKindOfValueError();
    var val = {};
    _.each(_.keys(o), function (key) {
      val[key.toString()] = o[key].toString();
    });
    self._set(key, val);
  },

  hincrby: function (key, field, delta) {
    var self = this;
    var o = self._has(key) ? self._get(key) : {};

    if (! _.isObject(o))
      throwIncorrectKindOfValueError();

    var val = _.has(o, field) ? o[field] : 0;
    // cast to integer
    var newVal = val |0;

    if (val !== newVal.toString())
      throw new Error("Value is not an integer or out of range");

    newVal += delta;
    var newObj = EJSON.clone(o);
    newObj[field] = newVal.toString();
    self._set(key, newObj);

    return newVal;
  }
});

Miniredis.unsupportedMethods = ["ttl", "restore", "dump", "expire", "expireat",
  "migrate", "move", "object", "persist", "pexpire", "pexpireat", "pttl",
  "bitcount", "bitop", "bitops", "getbit", "setbit", "psetex",
  "blpop", "brpop", "brpoplpush", "rpoplpush"];

_.each(Miniredis.unsupportedMethods, function (method) {
  Miniredis.RedisStore.prototype[method] = throwNotImplementedError;
});

Miniredis.List = function () {
  this._list = [];
};

_.extend(Miniredis.List.prototype, {
  // since the Miniredis.List will always be used through RedisStore, there
  // is no point of extra type-checking
  lpush: function (/* values */) {
    var values = _.invoke(arguments, "toString");
    Array.prototype.splice.apply(this._list, [0, 0].concat(values));
    return this._list.length;
  },
  rpush: function (/* values */) {
    var values = _.invoke(arguments, "toString");
    Array.prototype.push.apply(this._list, values);
    return this._list.length;
  },
  lpop: function () {
    var val = this._list.splice(0, 1)[0];
    return val === undefined ? null : val;
  },
  rpop: function () {
    var val = this._list.pop();
    return val === undefined ? null : val;
  },
  lindex: function (index) {
    if (index < 0)
      index = this._list.length + index;
    var val = this._list[index];
    return val === undefined ? null : val;
  },
  linsert: function (beforeAfter, pivot, value) {
    var self = this;
    var pos = _.indexOf(self._list, pivot.toString());
    var isBefore = beforeAfter.toLowerCase() === "before";

    if (pos === -1)
      return -1;

    self._list.splice(isBefore ? pos : pos + 1, 0, value.toString());
    return self._list.length;
  },
  lrange: function (start, stop) {
    var self = this;
    var normalizedBounds = normalizeBounds(start, stop, self._list.length);
    start = normalizedBounds.start;
    stop = normalizedBounds.end;

    if (start > stop)
      return [];

    return self._list.slice(start, stop + 1);
  },
  lset: function (index, value) {
    if (index < 0)
      index = this._length + index;
    this._list[index] = value.toString();
  },
  ltrim: function (start, stop) {
    this._list = this.lrange(start, stop);
  },
  llen: function () {
    return this._list.length;
  },
  type: function () { return "list"; },
  toArray: function () { return this._list.slice(0); },
  clone: function () {
    var list = new Miniredis.List();
    list._list = _.clone(this._list);
    return list;
  }
});

_.each(["lpushx", "rpushx"], function (method) {
  Miniredis.RedisStore.prototype[method] = function (key/* args */) {
    var self = this;

    if (! self._has(key))
      return 0;
    return self[method.slice(0, -1)].apply(self, arguments);
  };
});

_.each(["lpush", "rpush", "lpop", "rpop", "lindex", "linsert", "lrange",
        "lset", "ltrim", "llen"],
       function (method) {
         Miniredis.RedisStore.prototype[method] = function (key/*, args */) {
           var self = this;
           var args = _.toArray(arguments).slice(1);

           if (! self._has(key))
             self._set(key, new Miniredis.List);

           var list = self._get(key);
           if (! (list instanceof Miniredis.List))
             throwIncorrectKindOfValueError();

           var copy = list.clone();
           var res = Miniredis.List.prototype[method].apply(copy, args);
           self._set(key, copy);
           return res;
         };
       });

function normalizeBounds (start, end, len) {
  // put start and end into [0, len) range
  start %= len;
  if (start < 0)
    start += len;
  if (end >= len)
    end = len - 1;
  end %= len;
  if (end < 0)
    end += len;
  return { start: start, end: end };
}

function patternToRegexp (pattern) {
  // all special chars except for [, ], *, ?
  // - as they are used as is in patterns
  var specialChars = ".\\^$()+{}";
  var regexpStr = "^";

  _.each(pattern, function (ch) {
    if (_.contains(specialChars, ch))
      regexpStr += "\\";

    // "match one" operator
    if (ch === "?")
      ch = ".";
    // "match any number of chars" operator
    if (ch === "*")
      ch = ".*";

    regexpStr += ch;
  });

  regexpStr += "$";

  return new RegExp(regexpStr);
}

Miniredis.patternToRegexp = patternToRegexp;

