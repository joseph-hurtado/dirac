// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
/**
 * @unrestricted
 */
WebInspector.Context = class {
  constructor() {
    this._flavors = new Map();
    this._eventDispatchers = new Map();
  }

  /**
   * @param {function(new:T, ...)} flavorType
   * @param {?T} flavorValue
   * @template T
   */
  setFlavor(flavorType, flavorValue) {
    var value = this._flavors.get(flavorType) || null;
    if (value === flavorValue)
      return;
    if (flavorValue)
      this._flavors.set(flavorType, flavorValue);
    else
      this._flavors.remove(flavorType);

    this._dispatchFlavorChange(flavorType, flavorValue);
  }

  /**
   * @param {function(new:T, ...)} flavorType
   * @param {?T} flavorValue
   * @template T
   */
  _dispatchFlavorChange(flavorType, flavorValue) {
    for (var extension of self.runtime.extensions(WebInspector.ContextFlavorListener)) {
      if (extension.hasContextType(flavorType))
        extension.instance().then(
            instance => /** @type {!WebInspector.ContextFlavorListener} */ (instance).flavorChanged(flavorValue));
    }
    var dispatcher = this._eventDispatchers.get(flavorType);
    if (!dispatcher)
      return;
    dispatcher.dispatchEventToListeners(WebInspector.Context.Events.FlavorChanged, flavorValue);
  }

  /**
   * @param {function(new:Object, ...)} flavorType
   * @param {function(!WebInspector.Event)} listener
   * @param {!Object=} thisObject
   */
  addFlavorChangeListener(flavorType, listener, thisObject) {
    var dispatcher = this._eventDispatchers.get(flavorType);
    if (!dispatcher) {
      dispatcher = new WebInspector.Object();
      this._eventDispatchers.set(flavorType, dispatcher);
    }
    dispatcher.addEventListener(WebInspector.Context.Events.FlavorChanged, listener, thisObject);
  }

  /**
   * @param {function(new:Object, ...)} flavorType
   * @param {function(!WebInspector.Event)} listener
   * @param {!Object=} thisObject
   */
  removeFlavorChangeListener(flavorType, listener, thisObject) {
    var dispatcher = this._eventDispatchers.get(flavorType);
    if (!dispatcher)
      return;
    dispatcher.removeEventListener(WebInspector.Context.Events.FlavorChanged, listener, thisObject);
    if (!dispatcher.hasEventListeners(WebInspector.Context.Events.FlavorChanged))
      this._eventDispatchers.remove(flavorType);
  }

  /**
   * @param {function(new:T, ...)} flavorType
   * @return {?T}
   * @template T
   */
  flavor(flavorType) {
    return this._flavors.get(flavorType) || null;
  }

  /**
   * @return {!Set.<function(new:Object, ...)>}
   */
  flavors() {
    return new Set(this._flavors.keys());
  }

  /**
   * @param {!Array.<!Runtime.Extension>} extensions
   * @return {!Set.<!Runtime.Extension>}
   */
  applicableExtensions(extensions) {
    var targetExtensionSet = new Set();

    var availableFlavors = this.flavors();
    extensions.forEach(function(extension) {
      if (self.runtime.isExtensionApplicableToContextTypes(extension, availableFlavors))
        targetExtensionSet.add(extension);
    });

    return targetExtensionSet;
  }
};

/** @enum {symbol} */
WebInspector.Context.Events = {
  FlavorChanged: Symbol('FlavorChanged')
};

/**
 * @interface
 */
WebInspector.ContextFlavorListener = function() {};

WebInspector.ContextFlavorListener.prototype = {
  /**
   * @param {?Object} object
   */
  flavorChanged: function(object) {}
};

WebInspector.context = new WebInspector.Context();
