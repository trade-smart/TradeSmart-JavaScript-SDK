// Use the SDK from a CommonJS file: `require("tradesmart")`.
//
// The package is an ES module; Node 22.12 and later can `require()` it (no flag needed). Nothing
// is sent anywhere: the script only loads the package and prints what it exports.
//
//   node commonjs-require.cjs
const { TradeSmart, VERSION } = require("tradesmart");

console.log(`tradesmart ${VERSION} ${TradeSmart.name} ${typeof TradeSmart}`);
