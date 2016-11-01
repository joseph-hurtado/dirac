/*
 * Copyright (C) 2008 Nokia Inc.  All rights reserved.
 * Copyright (C) 2013 Samsung Electronics. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/**
 * @unrestricted
 */
WebInspector.DOMStorage = class extends WebInspector.Object {
  /**
   * @param {!WebInspector.DOMStorageModel} model
   * @param {string} securityOrigin
   * @param {boolean} isLocalStorage
   */
  constructor(model, securityOrigin, isLocalStorage) {
    super();
    this._model = model;
    this._securityOrigin = securityOrigin;
    this._isLocalStorage = isLocalStorage;
  }

  /**
   * @param {string} securityOrigin
   * @param {boolean} isLocalStorage
   * @return {!DOMStorageAgent.StorageId}
   */
  static storageId(securityOrigin, isLocalStorage) {
    return {securityOrigin: securityOrigin, isLocalStorage: isLocalStorage};
  }

  /** @return {!DOMStorageAgent.StorageId} */
  get id() {
    return WebInspector.DOMStorage.storageId(this._securityOrigin, this._isLocalStorage);
  }

  /** @return {string} */
  get securityOrigin() {
    return this._securityOrigin;
  }

  /** @return {boolean} */
  get isLocalStorage() {
    return this._isLocalStorage;
  }

  /**
   * @param {function(?Protocol.Error, !Array.<!DOMStorageAgent.Item>):void=} callback
   */
  getItems(callback) {
    this._model._agent.getDOMStorageItems(this.id, callback);
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  setItem(key, value) {
    this._model._agent.setDOMStorageItem(this.id, key, value);
  }

  /**
   * @param {string} key
   */
  removeItem(key) {
    this._model._agent.removeDOMStorageItem(this.id, key);
  }
};


/** @enum {symbol} */
WebInspector.DOMStorage.Events = {
  DOMStorageItemsCleared: Symbol('DOMStorageItemsCleared'),
  DOMStorageItemRemoved: Symbol('DOMStorageItemRemoved'),
  DOMStorageItemAdded: Symbol('DOMStorageItemAdded'),
  DOMStorageItemUpdated: Symbol('DOMStorageItemUpdated')
};

/**
 * @unrestricted
 */
WebInspector.DOMStorageModel = class extends WebInspector.SDKModel {
  /**
   * @param {!WebInspector.Target} target
   * @param {!WebInspector.SecurityOriginManager} securityOriginManager
   */
  constructor(target, securityOriginManager) {
    super(WebInspector.DOMStorageModel, target);

    this._securityOriginManager = securityOriginManager;
    /** @type {!Object.<string, !WebInspector.DOMStorage>} */
    this._storages = {};
    this._agent = target.domstorageAgent();
  }

  /**
   * @param {!WebInspector.Target} target
   * @return {!WebInspector.DOMStorageModel}
   */
  static fromTarget(target) {
    var model = /** @type {?WebInspector.DOMStorageModel} */ (target.model(WebInspector.DOMStorageModel));
    if (!model) {
      model = new WebInspector.DOMStorageModel(target, WebInspector.SecurityOriginManager.fromTarget(target));
    }
    return model;
  }

  enable() {
    if (this._enabled)
      return;

    this.target().registerDOMStorageDispatcher(new WebInspector.DOMStorageDispatcher(this));
    this._securityOriginManager.addEventListener(
        WebInspector.SecurityOriginManager.Events.SecurityOriginAdded, this._securityOriginAdded, this);
    this._securityOriginManager.addEventListener(
        WebInspector.SecurityOriginManager.Events.SecurityOriginRemoved, this._securityOriginRemoved, this);

    for (var securityOrigin of this._securityOriginManager.securityOrigins())
      this._addOrigin(securityOrigin);
    this._agent.enable();

    this._enabled = true;
  }

  /**
   * @param {string} origin
   */
  clearForOrigin(origin) {
    if (!this._enabled)
      return;
    this._removeOrigin(origin);
    this._addOrigin(origin);
  }

  /**
   * @param {!WebInspector.Event} event
   */
  _securityOriginAdded(event) {
    this._addOrigin(/** @type {string} */ (event.data));
  }

  /**
   * @param {string} securityOrigin
   */
  _addOrigin(securityOrigin) {
    var localStorageKey = this._storageKey(securityOrigin, true);
    console.assert(!this._storages[localStorageKey]);
    var localStorage = new WebInspector.DOMStorage(this, securityOrigin, true);
    this._storages[localStorageKey] = localStorage;
    this.dispatchEventToListeners(WebInspector.DOMStorageModel.Events.DOMStorageAdded, localStorage);

    var sessionStorageKey = this._storageKey(securityOrigin, false);
    console.assert(!this._storages[sessionStorageKey]);
    var sessionStorage = new WebInspector.DOMStorage(this, securityOrigin, false);
    this._storages[sessionStorageKey] = sessionStorage;
    this.dispatchEventToListeners(WebInspector.DOMStorageModel.Events.DOMStorageAdded, sessionStorage);
  }

  /**
   * @param {!WebInspector.Event} event
   */
  _securityOriginRemoved(event) {
    this._removeOrigin(/** @type {string} */ (event.data));
  }

  /**
   * @param {string} securityOrigin
   */
  _removeOrigin(securityOrigin) {
    var localStorageKey = this._storageKey(securityOrigin, true);
    var localStorage = this._storages[localStorageKey];
    console.assert(localStorage);
    delete this._storages[localStorageKey];
    this.dispatchEventToListeners(WebInspector.DOMStorageModel.Events.DOMStorageRemoved, localStorage);

    var sessionStorageKey = this._storageKey(securityOrigin, false);
    var sessionStorage = this._storages[sessionStorageKey];
    console.assert(sessionStorage);
    delete this._storages[sessionStorageKey];
    this.dispatchEventToListeners(WebInspector.DOMStorageModel.Events.DOMStorageRemoved, sessionStorage);
  }

  /**
   * @param {string} securityOrigin
   * @param {boolean} isLocalStorage
   * @return {string}
   */
  _storageKey(securityOrigin, isLocalStorage) {
    return JSON.stringify(WebInspector.DOMStorage.storageId(securityOrigin, isLocalStorage));
  }

  /**
   * @param {!DOMStorageAgent.StorageId} storageId
   */
  _domStorageItemsCleared(storageId) {
    var domStorage = this.storageForId(storageId);
    if (!domStorage)
      return;

    var eventData = {};
    domStorage.dispatchEventToListeners(WebInspector.DOMStorage.Events.DOMStorageItemsCleared, eventData);
  }

  /**
   * @param {!DOMStorageAgent.StorageId} storageId
   * @param {string} key
   */
  _domStorageItemRemoved(storageId, key) {
    var domStorage = this.storageForId(storageId);
    if (!domStorage)
      return;

    var eventData = {key: key};
    domStorage.dispatchEventToListeners(WebInspector.DOMStorage.Events.DOMStorageItemRemoved, eventData);
  }

  /**
   * @param {!DOMStorageAgent.StorageId} storageId
   * @param {string} key
   * @param {string} value
   */
  _domStorageItemAdded(storageId, key, value) {
    var domStorage = this.storageForId(storageId);
    if (!domStorage)
      return;

    var eventData = {key: key, value: value};
    domStorage.dispatchEventToListeners(WebInspector.DOMStorage.Events.DOMStorageItemAdded, eventData);
  }

  /**
   * @param {!DOMStorageAgent.StorageId} storageId
   * @param {string} key
   * @param {string} oldValue
   * @param {string} value
   */
  _domStorageItemUpdated(storageId, key, oldValue, value) {
    var domStorage = this.storageForId(storageId);
    if (!domStorage)
      return;

    var eventData = {key: key, oldValue: oldValue, value: value};
    domStorage.dispatchEventToListeners(WebInspector.DOMStorage.Events.DOMStorageItemUpdated, eventData);
  }

  /**
   * @param {!DOMStorageAgent.StorageId} storageId
   * @return {!WebInspector.DOMStorage}
   */
  storageForId(storageId) {
    return this._storages[JSON.stringify(storageId)];
  }

  /**
   * @return {!Array.<!WebInspector.DOMStorage>}
   */
  storages() {
    var result = [];
    for (var id in this._storages)
      result.push(this._storages[id]);
    return result;
  }
};

/** @enum {symbol} */
WebInspector.DOMStorageModel.Events = {
  DOMStorageAdded: Symbol('DOMStorageAdded'),
  DOMStorageRemoved: Symbol('DOMStorageRemoved')
};

/**
 * @implements {DOMStorageAgent.Dispatcher}
 * @unrestricted
 */
WebInspector.DOMStorageDispatcher = class {
  /**
   * @param {!WebInspector.DOMStorageModel} model
   */
  constructor(model) {
    this._model = model;
  }

  /**
   * @override
   * @param {!DOMStorageAgent.StorageId} storageId
   */
  domStorageItemsCleared(storageId) {
    this._model._domStorageItemsCleared(storageId);
  }

  /**
   * @override
   * @param {!DOMStorageAgent.StorageId} storageId
   * @param {string} key
   */
  domStorageItemRemoved(storageId, key) {
    this._model._domStorageItemRemoved(storageId, key);
  }

  /**
   * @override
   * @param {!DOMStorageAgent.StorageId} storageId
   * @param {string} key
   * @param {string} value
   */
  domStorageItemAdded(storageId, key, value) {
    this._model._domStorageItemAdded(storageId, key, value);
  }

  /**
   * @override
   * @param {!DOMStorageAgent.StorageId} storageId
   * @param {string} key
   * @param {string} oldValue
   * @param {string} value
   */
  domStorageItemUpdated(storageId, key, oldValue, value) {
    this._model._domStorageItemUpdated(storageId, key, oldValue, value);
  }
};

WebInspector.DOMStorageModel._symbol = Symbol('DomStorage');


