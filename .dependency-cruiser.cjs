/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [],
  options: {
    tsConfig: {
      fileName: "../gr8bookslite-backend/tsconfig.json",
    },
    includeOnly: "^../gr8bookslite-backend/src",
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "node_modules",
    },
  },
};