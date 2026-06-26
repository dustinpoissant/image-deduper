---
name: code-conventions
description: Basic rules for writing JavaScript code
---

# Code Style

## When to Use
Whenever writing JavaScript.

## Rules

### Casing
Use camel case for most variable/function names.

#### Do not do this 
```javascript
const my_var = 'foobar';
```

#### Do this instead
```javascript
const myVar = 'foobar';
```

Classes should start with a capital letter.

#### Do not do this
```javascript
class myClass {
  // ...
}
```

#### Do this instead
```javascript
class MyClass {
  // ...
}
```


### No single-use variables or functions
Do not declare a variable or function to simply call or use it once; just inline the logic.

#### Do not do this
```javascript
const myVar = myFunc();

if(myVar){
  // do something
}
```

#### Do this instead
```javascript
if(myFunc()){
  // do something
}
```


#### Don't do this
```javascript
renderMoreStuff(){
  return html`<p>More Stuff</p>`;
}
render(){
  return html`
    <p>The first thing</p>
    ${this.renderMoreStuff()}
  `;
}
```

#### Do this instead
```javascript
render(){
  return html`
    <p>The first thing</p>
    <p>More Stuff</p>
  `;
}
```

**Exception Note:** In Lit, you can use arrow functions inline as event handlers in the render function, but this mixes non-view logic into the view. Prefer defining event handler methods on the class for better separation of concerns. So this is the exception to the "no single-use functions" rule.

#### Don't do this (Lit event handler inline)
```javascript
render() {
  return html`<button @click=${e => this.doSomething(e)}>Click me</button>`;
}
```

#### Do this instead
```javascript
clickHandler(e) {
  this.doSomething(e);
}
render() {
  return html`<button @click=${this.clickHandler}>Click me</button>`;
}
```

### Prefer arrow functions
If the function does not need a specific context, or if it would benefit from inheriting the parent context, use an arrow function. Use the `function` keyword only when a new context is needed.

### Omit optional parentheses and braces

#### Don't do this
```javascript
const myFunc = (a) => {
  return 'foobar';
}
```

#### Do this instead
```javascript
const myFunc = a => 'foobar';
```


### Prefer ternaries
For simple conditional logic, prefer ternaries.

#### Don't do this
```javascript
const myFunc = a => {
  if(a) {
    return 'foo';
  } else {
    return 'bar';
  }
}
```
#### Do this instead
```javascript
const myFunc = a => a ? 'foo' : 'bar';
```

### No "hash" (`#`) private members/methods
These are not well supported on Safari, which means your code may not work reliably for all users. Instead, use symbol-keyed properties. I know this makes more code, but it has full browser support; hash private properties do not.

#### Dont do this
```javascript
class MyClass {
  #priv = 'bar';
  
  get foo(){
    return this.priv;
  }
}
```

#### Do this instead
```javascript
const priv = Symbol;
class MyClass {
  constructor(){
    this[priv] = 'bar';
  }
  
  get foo(){
    return this[priv];
  }
}
```