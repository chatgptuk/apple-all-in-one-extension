# UI symbols

`symbols.json` contains original drawings on a 24-point grid, rendered with round caps/joins and a 1.75-point stroke. They follow the proportions of system-style symbols but are not redistributed SF Symbols assets.

React's `Symbol` reads this catalog directly. Webpack also packages it as `src/symbols.js` for the isolated inline chooser. Add or update glyphs here, not independently in the two UIs. Keep paths static (no page or account data) and verify both 18- and 32-point rendering in the local icon preview.

The inline header uses the existing original cloud/keyhole brand mark. Website favicons remain the website's own identity.
