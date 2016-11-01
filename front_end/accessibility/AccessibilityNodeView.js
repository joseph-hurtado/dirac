// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
/**
 * @unrestricted
 */
WebInspector.AXNodeSubPane = class extends WebInspector.AccessibilitySubPane {
  constructor() {
    super(WebInspector.UIString('Computed Properties'));

    this._noNodeInfo = this.createInfo(WebInspector.UIString('No accessibility node'));
    this._ignoredInfo =
        this.createInfo(WebInspector.UIString('Accessibility node not exposed'), 'ax-ignored-info hidden');

    this._treeOutline = this.createTreeOutline();
    this._ignoredReasonsTree = this.createTreeOutline();

    this.element.classList.add('accessibility-computed');
  }

  /**
   * @param {?WebInspector.AccessibilityNode} axNode
   * @override
   */
  setAXNode(axNode) {
    if (this._axNode === axNode)
      return;
    this._axNode = axNode;

    var treeOutline = this._treeOutline;
    treeOutline.removeChildren();
    var ignoredReasons = this._ignoredReasonsTree;
    ignoredReasons.removeChildren();

    if (!axNode) {
      treeOutline.element.classList.add('hidden');
      this._ignoredInfo.classList.add('hidden');
      ignoredReasons.element.classList.add('hidden');

      this._noNodeInfo.classList.remove('hidden');
      this.element.classList.add('ax-ignored-node-pane');

      return;
    }

    if (axNode.ignored()) {
      this._noNodeInfo.classList.add('hidden');
      treeOutline.element.classList.add('hidden');
      this.element.classList.add('ax-ignored-node-pane');

      this._ignoredInfo.classList.remove('hidden');
      ignoredReasons.element.classList.remove('hidden');
      /**
       * @param {!AccessibilityAgent.AXProperty} property
       */
      function addIgnoredReason(property) {
        ignoredReasons.appendChild(new WebInspector.AXNodeIgnoredReasonTreeElement(
            property, /** @type {!WebInspector.AccessibilityNode} */ (axNode)));
      }
      var ignoredReasonsArray = /** @type {!Array<!AccessibilityAgent.AXProperty>} */ (axNode.ignoredReasons());
      for (var reason of ignoredReasonsArray)
        addIgnoredReason(reason);
      if (!ignoredReasons.firstChild())
        ignoredReasons.element.classList.add('hidden');
      return;
    }
    this.element.classList.remove('ax-ignored-node-pane');

    this._ignoredInfo.classList.add('hidden');
    ignoredReasons.element.classList.add('hidden');
    this._noNodeInfo.classList.add('hidden');

    treeOutline.element.classList.remove('hidden');

    /**
     * @param {!AccessibilityAgent.AXProperty} property
     */
    function addProperty(property) {
      treeOutline.appendChild(new WebInspector.AXNodePropertyTreePropertyElement(
          property, /** @type {!WebInspector.AccessibilityNode} */ (axNode)));
    }

    for (var property of axNode.coreProperties())
      addProperty(property);

    var roleProperty = /** @type {!AccessibilityAgent.AXProperty} */ ({name: 'role', value: axNode.role()});
    addProperty(roleProperty);

    var propertyMap = {};
    var propertiesArray = /** @type {!Array.<!AccessibilityAgent.AXProperty>} */ (axNode.properties());
    for (var property of propertiesArray)
      propertyMap[property.name] = property;

    for (var propertySet
             of [AccessibilityAgent.AXWidgetAttributes, AccessibilityAgent.AXWidgetStates,
                 AccessibilityAgent.AXGlobalStates, AccessibilityAgent.AXLiveRegionAttributes,
                 AccessibilityAgent.AXRelationshipAttributes]) {
      for (var propertyKey in propertySet) {
        var property = propertySet[propertyKey];
        if (property in propertyMap)
          addProperty(propertyMap[property]);
      }
    }
  }

  /**
   * @override
   * @param {?WebInspector.DOMNode} node
   */
  setNode(node) {
    super.setNode(node);
    this._axNode = null;
  }
};

/**
 * @unrestricted
 */
WebInspector.AXNodePropertyTreeElement = class extends TreeElement {
  /**
   * @param {!WebInspector.AccessibilityNode} axNode
   */
  constructor(axNode) {
    // Pass an empty title, the title gets made later in onattach.
    super('');
    this._axNode = axNode;
  }

  /**
   * @param {?AccessibilityAgent.AXValueType} type
   * @param {string} value
   * @return {!Element}
   */
  static createSimpleValueElement(type, value) {
    var valueElement;
    var AXValueType = AccessibilityAgent.AXValueType;
    if (!type || type === AXValueType.ValueUndefined || type === AXValueType.ComputedString)
      valueElement = createElement('span');
    else
      valueElement = createElementWithClass('span', 'monospace');
    var valueText;
    var isStringProperty = type && WebInspector.AXNodePropertyTreeElement.StringProperties.has(type);
    if (isStringProperty) {
      // Render \n as a nice unicode cr symbol.
      valueText = '"' + value.replace(/\n/g, '\u21B5') + '"';
      valueElement._originalTextContent = value;
    } else {
      valueText = String(value);
    }

    if (type && type in WebInspector.AXNodePropertyTreeElement.TypeStyles)
      valueElement.classList.add(WebInspector.AXNodePropertyTreeElement.TypeStyles[type]);

    valueElement.setTextContentTruncatedIfNeeded(valueText || '');

    valueElement.title = String(value) || '';

    return valueElement;
  }

  /**
   * @param {string} tooltip
   * @return {!Element}
   */
  static createExclamationMark(tooltip) {
    var exclamationElement = createElement('label', 'dt-icon-label');
    exclamationElement.type = 'warning-icon';
    exclamationElement.title = tooltip;
    return exclamationElement;
  }

  /**
   * @param {string} name
   */
  appendNameElement(name) {
    var nameElement = createElement('span');
    var AXAttributes = WebInspector.AccessibilityStrings.AXAttributes;
    if (name in AXAttributes) {
      nameElement.textContent = WebInspector.UIString(AXAttributes[name].name);
      nameElement.title = AXAttributes[name].description;
      nameElement.classList.add('ax-readable-name');
    } else {
      nameElement.textContent = name;
      nameElement.classList.add('ax-name');
      nameElement.classList.add('monospace');
    }
    this.listItemElement.appendChild(nameElement);
  }

  /**
   * @param {!AccessibilityAgent.AXValue} value
   * @return {?Element}
   */
  appendValueElement(value) {
    var AXValueType = AccessibilityAgent.AXValueType;
    if (value.type === AXValueType.Idref || value.type === AXValueType.Node || value.type === AXValueType.IdrefList ||
        value.type === AXValueType.NodeList) {
      this.appendRelatedNodeListValueElement(value);
      if (!value.value)
        return null;
    } else if (value.sources) {
      var sources = value.sources;
      for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var child = new WebInspector.AXValueSourceTreeElement(source, this._axNode);
        this.appendChild(child);
      }
      this.expand();
    }
    var element = WebInspector.AXNodePropertyTreeElement.createSimpleValueElement(value.type, String(value.value));
    this.listItemElement.appendChild(element);
    return element;
  }

  /**
   * @param {!AccessibilityAgent.AXRelatedNode} relatedNode
   * @param {number} index
   */
  appendRelatedNode(relatedNode, index) {
    var deferredNode = new WebInspector.DeferredDOMNode(this._axNode.target(), relatedNode.backendNodeId);
    var nodeTreeElement = new WebInspector.AXRelatedNodeSourceTreeElement({deferredNode: deferredNode}, relatedNode);
    this.appendChild(nodeTreeElement);
  }

  /**
   * @param {!AccessibilityAgent.AXRelatedNode} relatedNode
   */
  appendRelatedNodeInline(relatedNode) {
    var deferredNode = new WebInspector.DeferredDOMNode(this._axNode.target(), relatedNode.backendNodeId);
    var linkedNode = new WebInspector.AXRelatedNodeElement({deferredNode: deferredNode}, relatedNode);
    this.listItemElement.appendChild(linkedNode.render());
  }

  /**
   * @param {!AccessibilityAgent.AXValue} value
   */
  appendRelatedNodeListValueElement(value) {
    if (value.relatedNodes.length === 1 && !value.value) {
      this.appendRelatedNodeInline(value.relatedNodes[0]);
      return;
    }

    value.relatedNodes.forEach(this.appendRelatedNode, this);
    if (value.relatedNodes.length <= 3)
      this.expand();
    else
      this.collapse();
  }
};


/** @type {!Object<string, string>} */
WebInspector.AXNodePropertyTreeElement.TypeStyles = {
  attribute: 'ax-value-string',
  boolean: 'object-value-boolean',
  booleanOrUndefined: 'object-value-boolean',
  computedString: 'ax-readable-string',
  idref: 'ax-value-string',
  idrefList: 'ax-value-string',
  integer: 'object-value-number',
  internalRole: 'ax-internal-role',
  number: 'ax-value-number',
  role: 'ax-role',
  string: 'ax-value-string',
  tristate: 'object-value-boolean',
  valueUndefined: 'ax-value-undefined'
};

/** @type {!Set.<!AccessibilityAgent.AXValueType>} */
WebInspector.AXNodePropertyTreeElement.StringProperties = new Set([
  AccessibilityAgent.AXValueType.String, AccessibilityAgent.AXValueType.ComputedString,
  AccessibilityAgent.AXValueType.IdrefList, AccessibilityAgent.AXValueType.Idref
]);

/**
 * @unrestricted
 */
WebInspector.AXNodePropertyTreePropertyElement = class extends WebInspector.AXNodePropertyTreeElement {
  /**
   * @param {!AccessibilityAgent.AXProperty} property
   * @param {!WebInspector.AccessibilityNode} axNode
   */
  constructor(property, axNode) {
    super(axNode);

    this._property = property;
    this.toggleOnClick = true;
    this.selectable = false;

    this.listItemElement.classList.add('property');
  }

  /**
   * @override
   */
  onattach() {
    this._update();
  }

  _update() {
    this.listItemElement.removeChildren();

    this.appendNameElement(this._property.name);

    this.listItemElement.createChild('span', 'separator').textContent = ':\u00A0';

    var valueElement = this.appendValueElement(this._property.value);
    if (this._property.name === 'name')
      valueElement.classList.add('ax-computed-text');
  }
};

/**
 * @unrestricted
 */
WebInspector.AXValueSourceTreeElement = class extends WebInspector.AXNodePropertyTreeElement {
  /**
   * @param {!AccessibilityAgent.AXValueSource} source
   * @param {!WebInspector.AccessibilityNode} axNode
   */
  constructor(source, axNode) {
    super(axNode);
    this._source = source;
    this.selectable = false;
  }

  /**
   * @override
   */
  onattach() {
    this._update();
  }

  /**
   * @param {!AccessibilityAgent.AXRelatedNode} relatedNode
   * @param {number} index
   * @param {string} idref
   */
  appendRelatedNodeWithIdref(relatedNode, index, idref) {
    var deferredNode = new WebInspector.DeferredDOMNode(this._axNode.target(), relatedNode.backendNodeId);
    var nodeTreeElement =
        new WebInspector.AXRelatedNodeSourceTreeElement({deferredNode: deferredNode, idref: idref}, relatedNode);
    this.appendChild(nodeTreeElement);
  }

  /**
   * @param {!AccessibilityAgent.AXValue} value
   */
  appendIDRefValueElement(value) {
    var relatedNodes = value.relatedNodes;
    var numNodes = relatedNodes.length;
    var valueElement;

    var idrefs = value.value.trim().split(/\s+/);
    if (idrefs.length === 1) {
      var idref = idrefs[0];
      var matchingNode = relatedNodes.find(node => node.idref === idref);
      if (matchingNode) {
        this.appendRelatedNodeWithIdref(matchingNode, 0, idref);
      } else {
        this.listItemElement.appendChild(new WebInspector.AXRelatedNodeElement({idref: idref}).render());
      }
    } else {
      // TODO(aboxhall): exclamation mark if not idreflist type
      for (var i = 0; i < idrefs.length; ++i) {
        var idref = idrefs[i];
        var matchingNode = relatedNodes.find(node => node.idref === idref);
        if (matchingNode) {
          this.appendRelatedNodeWithIdref(matchingNode, i, idref);
        } else {
          this.appendChild(new WebInspector.AXRelatedNodeSourceTreeElement({idref: idref}));
        }
      }
    }
  }

  /**
   * @param {!AccessibilityAgent.AXValue} value
   * @override
   */
  appendRelatedNodeListValueElement(value) {
    var relatedNodes = value.relatedNodes;
    var numNodes = relatedNodes.length;

    if (value.type === AccessibilityAgent.AXValueType.IdrefList ||
        value.type === AccessibilityAgent.AXValueType.Idref) {
      this.appendIDRefValueElement(value);
    } else {
      super.appendRelatedNodeListValueElement(value);
    }

    if (numNodes <= 3)
      this.expand();
    else
      this.collapse();
  }

  /**
   * @param {!AccessibilityAgent.AXValueSource} source
   */
  appendSourceNameElement(source) {
    var nameElement = createElement('span');
    var AXValueSourceType = AccessibilityAgent.AXValueSourceType;
    var type = source.type;
    var name;
    switch (type) {
      case AXValueSourceType.Attribute:
      case AXValueSourceType.Placeholder:
      case AXValueSourceType.RelatedElement:
        if (source.nativeSource) {
          var AXNativeSourceTypes = WebInspector.AccessibilityStrings.AXNativeSourceTypes;
          var nativeSource = source.nativeSource;
          nameElement.textContent = WebInspector.UIString(AXNativeSourceTypes[nativeSource].name);
          nameElement.title = WebInspector.UIString(AXNativeSourceTypes[nativeSource].description);
          nameElement.classList.add('ax-readable-name');
          break;
        }
        nameElement.textContent = source.attribute;
        nameElement.classList.add('ax-name');
        nameElement.classList.add('monospace');
        break;
      default:
        var AXSourceTypes = WebInspector.AccessibilityStrings.AXSourceTypes;
        if (type in AXSourceTypes) {
          nameElement.textContent = WebInspector.UIString(AXSourceTypes[type].name);
          nameElement.title = WebInspector.UIString(AXSourceTypes[type].description);
          nameElement.classList.add('ax-readable-name');
        } else {
          console.warn(type, 'not in AXSourceTypes');
          nameElement.textContent = WebInspector.UIString(type);
        }
    }
    this.listItemElement.appendChild(nameElement);
  }

  _update() {
    this.listItemElement.removeChildren();

    if (this._source.invalid) {
      var exclamationMark =
          WebInspector.AXNodePropertyTreeElement.createExclamationMark(WebInspector.UIString('Invalid source.'));
      this.listItemElement.appendChild(exclamationMark);
      this.listItemElement.classList.add('ax-value-source-invalid');
    } else if (this._source.superseded) {
      this.listItemElement.classList.add('ax-value-source-unused');
    }

    this.appendSourceNameElement(this._source);

    this.listItemElement.createChild('span', 'separator').textContent = ':\u00a0';

    if (this._source.attributeValue) {
      this.appendValueElement(this._source.attributeValue);
      this.listItemElement.createTextChild('\u00a0');
    } else if (this._source.nativeSourceValue) {
      this.appendValueElement(this._source.nativeSourceValue);
      this.listItemElement.createTextChild('\u00a0');
    } else if (this._source.value) {
      this.appendValueElement(this._source.value);
    } else {
      var valueElement = WebInspector.AXNodePropertyTreeElement.createSimpleValueElement(
          AccessibilityAgent.AXValueType.ValueUndefined, WebInspector.UIString('Not specified'));
      this.listItemElement.appendChild(valueElement);
      this.listItemElement.classList.add('ax-value-source-unused');
    }

    if (this._source.value && this._source.superseded)
      this.listItemElement.classList.add('ax-value-source-superseded');
  }

  /**
   * @param {!AccessibilityAgent.AXValue} value
   * @return {!Element}
   * @override
   */
  appendValueElement(value) {
    var element = super.appendValueElement(value);
    if (!element) {
      element = WebInspector.AXNodePropertyTreeElement.createSimpleValueElement(value.type, String(value.value));
      this.listItemElement.appendChild(element);
    }
    return element;
  }
};

/**
 * @unrestricted
 */
WebInspector.AXRelatedNodeSourceTreeElement = class extends TreeElement {
  /**
   * @param {{deferredNode: (!WebInspector.DeferredDOMNode|undefined), idref: (string|undefined)}} node
   * @param {!AccessibilityAgent.AXRelatedNode=} value
   */
  constructor(node, value) {
    super('');

    this._value = value;
    this._axRelatedNodeElement = new WebInspector.AXRelatedNodeElement(node, value);
    this.selectable = false;
  }

  /**
   * @override
   */
  onattach() {
    this.listItemElement.appendChild(this._axRelatedNodeElement.render());
    if (!this._value)
      return;

    if (this._value.text)
      this.listItemElement.appendChild(WebInspector.AXNodePropertyTreeElement.createSimpleValueElement(
          AccessibilityAgent.AXValueType.ComputedString, this._value.text));
  }
};

/**
 * @unrestricted
 */
WebInspector.AXRelatedNodeElement = class {
  /**
   * @param {{deferredNode: (!WebInspector.DeferredDOMNode|undefined), idref: (string|undefined)}} node
   * @param {!AccessibilityAgent.AXRelatedNode=} value
   */
  constructor(node, value) {
    this._deferredNode = node.deferredNode;
    this._idref = node.idref;
    this._value = value;
  }

  /**
   * @return {!Element}
   */
  render() {
    var element = createElement('span');
    var valueElement;

    /**
     * @param {?WebInspector.DOMNode} node
     * @this {!WebInspector.AXRelatedNodeElement}
     */
    function onNodeResolved(node) {
      valueElement.appendChild(WebInspector.DOMPresentationUtils.linkifyNodeReference(node, this._idref));
    }

    if (this._deferredNode) {
      valueElement = createElement('span');
      element.appendChild(valueElement);
      this._deferredNode.resolve(onNodeResolved.bind(this));
    } else if (this._idref) {
      element.classList.add('invalid');
      valueElement =
          WebInspector.AXNodePropertyTreeElement.createExclamationMark(WebInspector.UIString('No node with this ID.'));
      valueElement.createTextChild(this._idref);
      element.appendChild(valueElement);
    }

    return element;
  }
};

/**
 * @unrestricted
 */
WebInspector.AXNodeIgnoredReasonTreeElement = class extends WebInspector.AXNodePropertyTreeElement {
  /**
   * @param {!AccessibilityAgent.AXProperty} property
   * @param {!WebInspector.AccessibilityNode} axNode
   */
  constructor(property, axNode) {
    super(axNode);
    this._property = property;
    this._axNode = axNode;
    this.toggleOnClick = true;
    this.selectable = false;
  }

  /**
   * @param {?string} reason
   * @param {?WebInspector.AccessibilityNode} axNode
   * @return {?Element}
   */
  static createReasonElement(reason, axNode) {
    var reasonElement = null;
    switch (reason) {
      case 'activeModalDialog':
        reasonElement = WebInspector.formatLocalized('Element is hidden by active modal dialog:\u00a0', []);
        break;
      case 'ancestorDisallowsChild':
        reasonElement = WebInspector.formatLocalized('Element is not permitted as child of ', []);
        break;
      // http://www.w3.org/TR/wai-aria/roles#childrenArePresentational
      case 'ancestorIsLeafNode':
        reasonElement = WebInspector.formatLocalized('Ancestor\'s children are all presentational:\u00a0', []);
        break;
      case 'ariaHidden':
        var ariaHiddenSpan = createElement('span', 'source-code').textContent = 'aria-hidden';
        reasonElement = WebInspector.formatLocalized('Element is %s.', [ariaHiddenSpan]);
        break;
      case 'ariaHiddenRoot':
        var ariaHiddenSpan = createElement('span', 'source-code').textContent = 'aria-hidden';
        var trueSpan = createElement('span', 'source-code').textContent = 'true';
        reasonElement = WebInspector.formatLocalized('%s is %s on ancestor:\u00a0', [ariaHiddenSpan, trueSpan]);
        break;
      case 'emptyAlt':
        reasonElement = WebInspector.formatLocalized('Element has empty alt text.', []);
        break;
      case 'emptyText':
        reasonElement = WebInspector.formatLocalized('No text content.', []);
        break;
      case 'inert':
        reasonElement = WebInspector.formatLocalized('Element is inert.', []);
        break;
      case 'inheritsPresentation':
        reasonElement = WebInspector.formatLocalized('Element inherits presentational role from\u00a0', []);
        break;
      case 'labelContainer':
        reasonElement = WebInspector.formatLocalized('Part of label element:\u00a0', []);
        break;
      case 'labelFor':
        reasonElement = WebInspector.formatLocalized('Label for\u00a0', []);
        break;
      case 'notRendered':
        reasonElement = WebInspector.formatLocalized('Element is not rendered.', []);
        break;
      case 'notVisible':
        reasonElement = WebInspector.formatLocalized('Element is not visible.', []);
        break;
      case 'presentationalRole':
        var rolePresentationSpan = createElement('span', 'source-code').textContent = 'role=' + axNode.role().value;
        reasonElement = WebInspector.formatLocalized('Element has %s.', [rolePresentationSpan]);
        break;
      case 'probablyPresentational':
        reasonElement = WebInspector.formatLocalized('Element is presentational.', []);
        break;
      case 'staticTextUsedAsNameFor':
        reasonElement = WebInspector.formatLocalized('Static text node is used as name for\u00a0', []);
        break;
      case 'uninteresting':
        reasonElement = WebInspector.formatLocalized('Element not interesting for accessibility.', []);
        break;
    }
    if (reasonElement)
      reasonElement.classList.add('ax-reason');
    return reasonElement;
  }

  /**
   * @override
   */
  onattach() {
    this.listItemElement.removeChildren();

    this._reasonElement =
        WebInspector.AXNodeIgnoredReasonTreeElement.createReasonElement(this._property.name, this._axNode);
    this.listItemElement.appendChild(this._reasonElement);

    var value = this._property.value;
    if (value.type === AccessibilityAgent.AXValueType.Idref)
      this.appendRelatedNodeListValueElement(value);
  }
};


