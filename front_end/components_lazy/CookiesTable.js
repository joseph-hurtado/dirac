/*
 * Copyright (C) 2009 Apple Inc.  All rights reserved.
 * Copyright (C) 2009 Joseph Pecoraro
 * Copyright (C) 2010 Google Inc. All rights reserved.
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
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
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
WebInspector.CookiesTable = class extends WebInspector.VBox {
  /**
   * @param {boolean} expandable
   * @param {function()=} refreshCallback
   * @param {function()=} selectedCallback
   */
  constructor(expandable, refreshCallback, selectedCallback) {
    super();

    var readOnly = expandable;
    this._refreshCallback = refreshCallback;

    var columns = /** @type {!Array<!WebInspector.DataGrid.ColumnDescriptor>} */ ([
      {
        id: 'name',
        title: WebInspector.UIString('Name'),
        sortable: true,
        disclosure: expandable,
        sort: WebInspector.DataGrid.Order.Ascending,
        longText: true,
        weight: 24
      },
      {id: 'value', title: WebInspector.UIString('Value'), sortable: true, longText: true, weight: 34},
      {id: 'domain', title: WebInspector.UIString('Domain'), sortable: true, weight: 7},
      {id: 'path', title: WebInspector.UIString('Path'), sortable: true, weight: 7},
      {id: 'expires', title: WebInspector.UIString('Expires / Max-Age'), sortable: true, weight: 7}, {
        id: 'size',
        title: WebInspector.UIString('Size'),
        sortable: true,
        align: WebInspector.DataGrid.Align.Right,
        weight: 7
      },
      {
        id: 'httpOnly',
        title: WebInspector.UIString('HTTP'),
        sortable: true,
        align: WebInspector.DataGrid.Align.Center,
        weight: 7
      },
      {
        id: 'secure',
        title: WebInspector.UIString('Secure'),
        sortable: true,
        align: WebInspector.DataGrid.Align.Center,
        weight: 7
      },
      {
        id: 'sameSite',
        title: WebInspector.UIString('SameSite'),
        sortable: true,
        align: WebInspector.DataGrid.Align.Center,
        weight: 7
      }
    ]);

    if (readOnly) {
      this._dataGrid = new WebInspector.DataGrid(columns);
    } else {
      this._dataGrid = new WebInspector.DataGrid(columns, undefined, this._onDeleteCookie.bind(this), refreshCallback);
      this._dataGrid.setRowContextMenuCallback(this._onRowContextMenu.bind(this));
    }

    this._dataGrid.setName('cookiesTable');
    this._dataGrid.addEventListener(WebInspector.DataGrid.Events.SortingChanged, this._rebuildTable, this);

    if (selectedCallback)
      this._dataGrid.addEventListener(WebInspector.DataGrid.Events.SelectedNode, selectedCallback, this);

    this._nextSelectedCookie = /** @type {?WebInspector.Cookie} */ (null);

    this._dataGrid.asWidget().show(this.element);
    this._data = [];
  }

  /**
   * @param {?string} domain
   */
  _clearAndRefresh(domain) {
    this.clear(domain);
    this._refresh();
  }

  /**
   * @param {!WebInspector.ContextMenu} contextMenu
   * @param {!WebInspector.DataGridNode} node
   */
  _onRowContextMenu(contextMenu, node) {
    if (node === this._dataGrid.creationNode)
      return;
    var domain = node.cookie.domain();
    if (domain)
      contextMenu.appendItem(
          WebInspector.UIString.capitalize('Clear ^all from "%s"', domain), this._clearAndRefresh.bind(this, domain));
    contextMenu.appendItem(WebInspector.UIString.capitalize('Clear ^all'), this._clearAndRefresh.bind(this, null));
  }

  /**
   * @param {!Array.<!WebInspector.Cookie>} cookies
   */
  setCookies(cookies) {
    this.setCookieFolders([{cookies: cookies}]);
  }

  /**
   * @param {!Array.<!{folderName: ?string, cookies: !Array.<!WebInspector.Cookie>}>} cookieFolders
   */
  setCookieFolders(cookieFolders) {
    this._data = cookieFolders;
    this._rebuildTable();
  }

  /**
   * @return {?WebInspector.Cookie}
   */
  selectedCookie() {
    var node = this._dataGrid.selectedNode;
    return node ? node.cookie : null;
  }

  /**
   * @param {?string=} domain
   */
  clear(domain) {
    for (var i = 0, length = this._data.length; i < length; ++i) {
      var cookies = this._data[i].cookies;
      for (var j = 0, cookieCount = cookies.length; j < cookieCount; ++j) {
        if (!domain || cookies[j].domain() === domain)
          cookies[j].remove();
      }
    }
  }

  _rebuildTable() {
    var selectedCookie = this._nextSelectedCookie || this.selectedCookie();
    this._nextSelectedCookie = null;
    this._dataGrid.rootNode().removeChildren();
    for (var i = 0; i < this._data.length; ++i) {
      var item = this._data[i];
      if (item.folderName) {
        var groupData = {
          name: item.folderName,
          value: '',
          domain: '',
          path: '',
          expires: '',
          size: this._totalSize(item.cookies),
          httpOnly: '',
          secure: '',
          sameSite: ''
        };
        var groupNode = new WebInspector.DataGridNode(groupData);
        groupNode.selectable = true;
        this._dataGrid.rootNode().appendChild(groupNode);
        groupNode.element().classList.add('row-group');
        this._populateNode(groupNode, item.cookies, selectedCookie);
        groupNode.expand();
      } else
        this._populateNode(this._dataGrid.rootNode(), item.cookies, selectedCookie);
    }
  }

  /**
   * @param {!WebInspector.DataGridNode} parentNode
   * @param {?Array.<!WebInspector.Cookie>} cookies
   * @param {?WebInspector.Cookie} selectedCookie
   */
  _populateNode(parentNode, cookies, selectedCookie) {
    parentNode.removeChildren();
    if (!cookies)
      return;

    this._sortCookies(cookies);
    for (var i = 0; i < cookies.length; ++i) {
      var cookie = cookies[i];
      var cookieNode = this._createGridNode(cookie);
      parentNode.appendChild(cookieNode);
      if (selectedCookie && selectedCookie.name() === cookie.name() && selectedCookie.domain() === cookie.domain() &&
          selectedCookie.path() === cookie.path())
        cookieNode.select();
    }
  }

  _totalSize(cookies) {
    var totalSize = 0;
    for (var i = 0; cookies && i < cookies.length; ++i)
      totalSize += cookies[i].size();
    return totalSize;
  }

  /**
   * @param {!Array.<!WebInspector.Cookie>} cookies
   */
  _sortCookies(cookies) {
    var sortDirection = this._dataGrid.isSortOrderAscending() ? 1 : -1;

    /**
     * @param {string} property
     * @param {!WebInspector.Cookie} cookie1
     * @param {!WebInspector.Cookie} cookie2
     */
    function compareTo(property, cookie1, cookie2) {
      return sortDirection *
          (String(cookie1[property] || cookie1['name'])).compareTo(String(cookie2[property] || cookie2['name']));
    }

    /**
     * @param {!WebInspector.Cookie} cookie1
     * @param {!WebInspector.Cookie} cookie2
     */
    function numberCompare(cookie1, cookie2) {
      return sortDirection * (cookie1.size() - cookie2.size());
    }

    /**
     * @param {!WebInspector.Cookie} cookie1
     * @param {!WebInspector.Cookie} cookie2
     */
    function expiresCompare(cookie1, cookie2) {
      if (cookie1.session() !== cookie2.session())
        return sortDirection * (cookie1.session() ? 1 : -1);

      if (cookie1.session())
        return 0;

      if (cookie1.maxAge() && cookie2.maxAge())
        return sortDirection * (cookie1.maxAge() - cookie2.maxAge());
      if (cookie1.expires() && cookie2.expires())
        return sortDirection * (cookie1.expires() - cookie2.expires());
      return sortDirection * (cookie1.expires() ? 1 : -1);
    }

    var comparator;
    var columnId = this._dataGrid.sortColumnId() || 'name';
    if (columnId === 'expires')
      comparator = expiresCompare;
    else if (columnId === 'size')
      comparator = numberCompare;
    else
      comparator = compareTo.bind(null, columnId);
    cookies.sort(comparator);
  }

  /**
   * @param {!WebInspector.Cookie} cookie
   * @return {!WebInspector.DataGridNode}
   */
  _createGridNode(cookie) {
    var data = {};
    data.name = cookie.name();
    data.value = cookie.value();
    if (cookie.type() === WebInspector.Cookie.Type.Request) {
      data.domain = WebInspector.UIString('N/A');
      data.path = WebInspector.UIString('N/A');
      data.expires = WebInspector.UIString('N/A');
    } else {
      data.domain = cookie.domain() || '';
      data.path = cookie.path() || '';
      if (cookie.maxAge())
        data.expires = Number.secondsToString(parseInt(cookie.maxAge(), 10));
      else if (cookie.expires())
        data.expires = new Date(cookie.expires()).toISOString();
      else
        data.expires = WebInspector.UIString('Session');
    }
    data.size = cookie.size();
    const checkmark = '\u2713';
    data.httpOnly = (cookie.httpOnly() ? checkmark : '');
    data.secure = (cookie.secure() ? checkmark : '');
    data.sameSite = cookie.sameSite() || '';

    var node = new WebInspector.DataGridNode(data);
    node.cookie = cookie;
    node.selectable = true;
    return node;
  }

  _onDeleteCookie(node) {
    var cookie = node.cookie;
    var neighbour = node.traverseNextNode() || node.traversePreviousNode();
    if (neighbour)
      this._nextSelectedCookie = neighbour.cookie;
    cookie.remove();
    this._refresh();
  }

  _refresh() {
    if (this._refreshCallback)
      this._refreshCallback();
  }
};
