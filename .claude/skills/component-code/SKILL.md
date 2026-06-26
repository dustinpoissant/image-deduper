---
name: component-code
description: Instructions on how to code components using a kempo-ui base component, the component should first be setup by the "component-setup" skill.
---

# Code Component

## When to Use
After you have already use the "component-setup" skill to create and scafold the component, use this skill to generate the structure and logic of the component.

## Sections

Break the component up into sections, denoting the start of each section with a multiline comment with blank line above it (except the first section in the class definition).
```

/*
  Section Name
*/
```

Not all of these sections are needed, but when they are use these names, and preserve this order. If a section has nothing in it, do not create the section title comment.

### Utility Functions
Define reusable utiltiy functions at the top of the page (after imports) before the class is defined/exported.

### Symbols
Any symbols defined in this file should be defined after the utility functions section, before the class is defined/exported.

### Reative Properties / Attributes
These is the Lit `static properties` object that is used to define the reactive properties / attributes. 

### Constructor
This is the class `constructor` inside the class.

### Private Members
Within the constructor, define private members (variables belonging to the class that can not be accessed outside this file). These are symbol-keyed properties.

### Private Methods
Within the contstructor, define private methods (functions belonging to the class that can not be accessed outside this file). These are symbol-keyed properties, they use arrow functions to preserver the class as the context.

### Init Props
Initialize the Lit property values, 

### Lifecycle
Lifecycle callbacks, this includes default web component lifecycle callbacks, Lit lifecyle callbacks (except `render`) and kempo-ui lifecyle callback.

kempo-ui adds the `childrenUpdated` callback, it is called by a MutationObserver when a child has been udpated.

The `render` and `renderLightDom` lifecycle callbacks should be excluded from this section, see the "Rendering" section below for more details.
 
### Protected Members
These are members using getters and setters so they are "protected" by the class and can not be arbitrarily set to anything the consumer wants.

### Public Methods
These are generic functions that belong to the class that the consumer would use to interact with the class (not event handlers).

### Event Handlers
These are the functions that belong to the class that are used for handling events.

### Rendering
This is where the `render` function (or `renderLightDom`) should go (not in the lifecycle section) and the `static styles` definition.

I like to see my markup (in `render` and `renderLightDom`) and styles right next to each other, so thats why we have have a section dedicated to these.

## Example Component
Again, each section is optional, if it is not needed, dont bother creating the section title comment.
```javascript
// imports here at the top of the file

/*
  Utility Functions
*/
const myFunc = () => {
  return 'foobar';
}

/*
  Symbols
*/
const privateMember1 = Symbol();
const privateMethod1 = Symbol();

export default class MyComponent extends ShadowComponent {
  /*
    Reative Properties / Attributes
  */
  static properties = {
    value: { type: String, reflect: true },
    name: { type: string, reflect: true }
  }
  
  /*
    Constructor
  */
  constructor(){
    super(); // always call super at the top of the constructor
    
    /*
      Private Members
    */
    this[privateMember1] = 'foobar';
    
    /*
      Private Methods
    */
    this[privateMethod1] = () => {
      return 'foobar';
    }
    
    /*
      Init Props
    */
    this.value = '';
    this.name = '';
    
    /*
      Init
    */
    // Other code to initialize the component
  }
  
  /*
    Lifecycle Callbacks
  */
  connectedCallback(){
    super.connectedCallback(); // most the time we want to call the parent's version of the lifecycle callback at the top of the function, rarely we are trying to overwrite that logic, not extend it, an so it should be skipped.
    // connected logic here
  }
  
  /*
    Protected Members
  */
  get protectedMember1(){
    return `${this[privateMember1]} ${this[privateMethod1]()}`;
  }
  set protectedMember1(val){
    const [ newPrivMem1 ] = val.split(' ');
    this[privateMember1] = newPrivMem1;
  }
  
  /*
    Public Methods
  */
  foo(){
    return 'bar';
  }
  
  /*
    Event Handlers
  */
  clickHandler(){
    console.log('foobar');
  }
  
  /*
    Rendering
  */
  render(){
    return html`
      <button class="primary" @click=${this.clickHandler}>Click Me</button>
    `;
  }
  static styles = css`
    button {
      border: red;
    }
  `;
}
```

## Rules

### One component per file
This is a soft rule, sometimes there are components that will always be used togehter, never one without the other, for example in the Accordion component we define the `Accordion`, `AccoridonHeader` and `AccordionPanel` all in the same file, each one of these requires the other 100% of the time, one will never be used without the other two. So they live in the same file, the primary component (in this case `Accordion`) is the default export (and file name), and the other two are named exports.

Another example that looks similar but is not the same is components with controls. `CodeEditor`, `HtmlEditor`, `MarkdownEditor`, and `Table` all have "controls" for them, but they are **not** defined in the same file because while the contorl can not be used without the base component, the base component **can** be used without any of the controls. We are not going to send more bytes to the browser than it needs. With HTTP2 making additional requests has very low costs, we are better off doing many smaller requests for only the code needed, than shipping code that may never be used. And a build / bundler may make this mute anyways, so this is better for code maintainability.

### Follow common code styles
Follow the rules of the ["code-style" skill](../code-style/SKILL.md) when coding components.
