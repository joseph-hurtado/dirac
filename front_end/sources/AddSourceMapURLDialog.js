// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
/**
 * @unrestricted
 */
WebInspector.AddSourceMapURLDialog = class extends WebInspector.HBox {
  /**
   * @param {function(string)} callback
   */
  constructor(callback) {
    super(true);
    this.registerRequiredCSS('ui_lazy/dialog.css');
    this.contentElement.createChild('label').textContent = WebInspector.UIString('Source map URL: ');

    this._input = this.contentElement.createChild('input');
    this._input.setAttribute('type', 'text');
    this._input.addEventListener('keydown', this._onKeyDown.bind(this), false);

    var addButton = this.contentElement.createChild('button');
    addButton.textContent = WebInspector.UIString('Add');
    addButton.addEventListener('click', this._apply.bind(this), false);

    this.setDefaultFocusedElement(this._input);
    this._callback = callback;
    this.contentElement.tabIndex = 0;
  }

  /**
   * @param {function(string)} callback
   */
  static show(callback) {
    var dialog = new WebInspector.Dialog();
    var addSourceMapURLDialog = new WebInspector.AddSourceMapURLDialog(done);
    addSourceMapURLDialog.show(dialog.element);
    dialog.setWrapsContent(true);
    dialog.show();

    /**
     * @param {string} value
     */
    function done(value) {
      dialog.detach();
      callback(value);
    }
  }

  _apply() {
    this._callback(this._input.value);
  }

  /**
   * @param {!Event} event
   */
  _onKeyDown(event) {
    if (event.keyCode === WebInspector.KeyboardShortcut.Keys.Enter.code) {
      event.preventDefault();
      this._apply();
    }
  }
};


