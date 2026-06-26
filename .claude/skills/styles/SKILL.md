---
name: styles
description: Whenever making html changes (or js rendered html) use this to properly style the markup
---

# Styles

## When to Use
Use this skill whenever you are making HTML changes, or even HTML-in-JS (like Kempo-UI or Lit components).

## Kempo-CSS
Most of my projects use the "kempo-css" style framework, not Bootstrap.

First, read the [llms.txt](https://raw.githubusercontent.com/dustinpoissant/kempo-css/refs/heads/main/llms.txt) file. It will most likely contain all the information you need.

If you can't find what you're looking for there, read the [source code](https://raw.githubusercontent.com/dustinpoissant/kempo-css/refs/heads/main/src/kempo.css). This file is shorter and requires fewer fetch calls than the [full docs](https://dustinpoissant.github.io/kempo-css/).

Only read the full docs if you are debugging a CSS issue and can't find the solution in the source code, as the docs have usage examples.

## Rules

### Most elements don't need styles or classes
Unlike Bootstrap, kempo-css takes the approach that if it is added to a site where elements have no special classes, but are semantically correct, it will give a pretty decent style by default. For example: `<button>` elements do not need a `btn` class, but you can use one to make a non-button (like a link) look like a button. So most of the time, you don't need to do anything to make the markup look good—just use good semantic markup.

### Prefer classes over custom styles
95% of styles that I would want are either applied automatically (see above) or can be added with some basic utility classes. The `llms.txt` outlines the most commonly used utility classes. The most commonly used utility classes are probably for spacing; most things need an `mb` or "margin bottom".

### Prefer inline styles over style tags or stylesheets for single use
Sometimes you need to add a style to a single element that does not have a utility class. If it is in an HTML file, just use an inline style.

If many elements need the same style, give them a class and add a style tag to the head of the document.

If the style is used in many places across the site, consider making it a component (if the repo has `kempo-ui` as a dependency).

If it does not make sense as a component and is used on multiple pages, first look for a `styles.css` for that project and add the styles there (or create it and import it if it doesn't exist).

### Prefer `static styles` over inline styles for components

If you are creating a component, you probably want to use the Lit `static styles` over inline styles on the element. Just give it a class (if many instances) or id, and style it the Lit way.

### Tables
All tables should be wrapped in a div with a class of `"table-wrapper mb"`, make it responsive and add a margin bottom.
