const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const TOML = require("@iarna/toml");
const copy = require("recursive-copy");
const dependencyTree = require("@11ty/dependency-tree");
const TemplatePath = require("../TemplatePath");
const deleteRequireCache = require("../Util/DeleteRequireCache");
const debug = require("debug")("Eleventy:Serverless");

// Provider specific
const redirectHandlers = {
  "netlify-toml": function (name, outputMap) {
    let newRedirects = [];
    for (let url in outputMap) {
      newRedirects.push({
        from: url,
        to: `/.netlify/functions/${name}`,
        status: 200,
        force: true,
        _generated_by_eleventy_serverless: name,
      });
    }

    let configFilename = "./netlify.toml";
    let cfg = {};
    // parse existing netlify.toml
    if (fs.existsSync(configFilename)) {
      cfg = TOML.parse(fs.readFileSync(configFilename));
    }
    let cfgWithRedirects = addRedirectsWithoutDuplicates(
      name,
      cfg,
      newRedirects
    );

    fs.writeFileSync(configFilename, TOML.stringify(cfgWithRedirects));
    debug(
      `Eleventy Serverless (${name}), writing (×${newRedirects.length}): ${configFilename}`
    );
  },
};

function getNodeModulesList(files) {
  let pkgs = new Set();

  let jsFiles = files.filter((entry) => entry.endsWith(".js"));

  for (let filepath of jsFiles) {
    let modules = dependencyTree(filepath, {
      nodeModuleNamesOnly: true,
      allowNotFound: true, // TODO is this okay?
    });

    for (let name of modules) {
      pkgs.add(name);
    }
  }

  return Array.from(pkgs).sort();
}

function addRedirectsWithoutDuplicates(name, config, newRedirects) {
  // keep non-generated redirects or those generated by a different function
  let redirects = (config.redirects || []).filter((entry) => {
    return (
      !entry._generated_by_eleventy_serverless ||
      entry._generated_by_eleventy_serverless !== name
    );
  });

  // Sort for stable order
  newRedirects.sort((a, b) => {
    if (a.from < b.from) {
      return -1;
    } else if (a.from > b.from) {
      return 1;
    }
    return 0;
  });

  for (let r of newRedirects) {
    let found = false;
    for (let entry of redirects) {
      if (r.from === entry.from && r.to === entry.to) {
        found = true;
      }
    }
    if (!found) {
      redirects.unshift(r);
    }
  }

  if (redirects.length) {
    config.redirects = redirects;
  } else {
    delete config.redirects;
  }

  return config;
}

class BundlerHelper {
  constructor(name, options) {
    this.name = name;
    this.options = options;
    this.dir = path.join(options.functionsDir, name);
    this.copyCount = 0;
  }

  reset() {
    this.copyCount = 0;
  }

  getOutputPath(filepath) {
    return TemplatePath.addLeadingDotSlash(path.join(this.dir, filepath));
  }

  copyFile(fullPath, outputFilename) {
    debug(
      `Eleventy Serverless: Copying ${fullPath} to ${this.getOutputPath(
        outputFilename
      )}`
    );
    fs.copyFileSync(fullPath, this.getOutputPath(outputFilename));
    this.copyCount++;
  }

  recursiveCopy(src, dest, options = {}) {
    let finalDest = this.getOutputPath(dest || src);
    return copy(
      src,
      finalDest,
      Object.assign(
        {
          overwrite: true,
          dot: true,
          junk: false,
          results: false,
        },
        this.options.copyOptions,
        options
      )
    ).on(copy.events.COPY_FILE_COMPLETE, () => {
      this.copyCount++;
    });
  }

  writeBundlerDependenciesFile(filename, deps = []) {
    let modules = deps.map((name) => `require("${name}");`);
    let fullPath = this.getOutputPath(filename);
    fs.writeFileSync(fullPath, modules.join("\n"));
    this.copyCount++;
    debug(
      `Writing a file to make it very obvious to the serverless bundler which extra \`require\`s are needed from the config file (×${modules.length}): ${fullPath}`
    );
  }

  writeDependencyEntryFile() {
    // we write this even when disabled because the serverless function expects it
    this.writeBundlerDependenciesFile(
      "eleventy-bundler-modules.js",
      this.options.copyEnabled
        ? [
            "./eleventy-app-config-modules.js",
            "./eleventy-app-globaldata-modules.js",
          ]
        : []
    );
  }

  writeDependencyConfigFile(configPath) {
    if (!this.options.copyEnabled) {
      return;
    }

    let modules = getNodeModulesList([configPath]);
    this.writeBundlerDependenciesFile(
      "eleventy-app-config-modules.js",
      modules.filter(
        (name) => this.options.excludeDependencies.indexOf(name) === -1
      )
    );
  }

  writeDependencyGlobalDataFile(globalDataFileList) {
    if (!this.options.copyEnabled) {
      return;
    }

    let modules = getNodeModulesList(globalDataFileList);
    this.writeBundlerDependenciesFile(
      "eleventy-app-globaldata-modules.js",
      modules.filter(
        (name) => this.options.excludeDependencies.indexOf(name) === -1
      )
    );
  }

  browserSyncMiddleware() {
    let serverlessFilepath = TemplatePath.addLeadingDotSlash(
      path.join(TemplatePath.getWorkingDir(), this.dir, "index")
    );
    deleteRequireCache(TemplatePath.absolutePath(serverlessFilepath));

    return async (req, res, next) => {
      let serverlessFunction = require(serverlessFilepath);
      let url = new URL(req.url, "http://localhost/"); // any domain will do here, we just want the searchParams
      let queryParams = Object.fromEntries(url.searchParams);

      let start = new Date();
      let result = await serverlessFunction.handler({
        httpMethod: "GET",
        path: url.pathname,
        // @netlify/functions builder overwrites these to {} intentionally
        // See https://github.com/netlify/functions/issues/38
        queryStringParameters: queryParams,
      });

      if (result.statusCode === 404) {
        // return static file
        return next();
      }

      res.writeHead(result.statusCode, result.headers || {});
      res.write(result.body);
      res.end();

      console.log(
        `Serverless (${this.name}): ${req.url} (${Date.now() - start}ms)`
      );
    };
  }

  async ensureDir() {
    return fsp.mkdir(this.getOutputPath(""), {
      recursive: true,
    });
  }

  async writeServerlessFunctionFile() {
    let filepath = this.getOutputPath("index.js");
    if (!fs.existsSync(filepath)) {
      let defaultContentPath = TemplatePath.absolutePath(
        __dirname,
        "./DefaultServerlessFunctionContent.js"
      );

      let contents = await fsp.readFile(defaultContentPath, "utf-8");
      contents = contents.replace(/\%\%NAME\%\%/g, this.name);
      contents = contents.replace(/\%\%INPUT_DIR\%\%/g, this.options.inputDir);
      contents = contents.replace(
        /\%\%FUNCTIONS_DIR\%\%/g,
        this.options.functionsDir
      );
      return fsp.writeFile(filepath, contents);
    }
  }
}

function EleventyPlugin(eleventyConfig, options = {}) {
  options = Object.assign(
    {
      name: "",
      functionsDir: "./functions/",
      copy: [],

      // https://www.npmjs.com/package/recursive-copy#usage
      copyOptions: {},

      // Dependencies explicitly declared from configuration and global data can be excluded and hidden from bundler.
      // Excluded from: `eleventy-app-config-modules.js` and `eleventy-app-globaldata-modules.js`
      excludeDependencies: [],

      // Add automated redirects (appends or creates, avoids duplicate entries)
      // Also accepts a custom callback function(name, outputMap)
      redirects: "netlify-toml",

      // Useful for local develop to disable all bundle copying
      copyEnabled: true,

      // Input directory (used to generate the default serverless file)
      inputDir: ".",
    },
    options
  );

  if (!options.name) {
    throw new Error(
      "Serverless addPlugin second argument options object must have a name."
    );
  }

  if (process.env.ELEVENTY_SOURCE === "cli") {
    let helper = new BundlerHelper(options.name, options);

    eleventyConfig.setBrowserSyncConfig({
      middleware: [helper.browserSyncMiddleware()],
    });

    eleventyConfig.on("eleventy.before", async () => {
      helper.reset();
      await helper.ensureDir();
      await helper.writeServerlessFunctionFile();
      helper.writeDependencyEntryFile();
    });

    eleventyConfig.on("eleventy.after", async () => {
      if (!options.copyEnabled) {
        return;
      }

      // extra copy targets
      // we put these in after a build so that we can grab files generated _by_ the build too
      if (options.copy && Array.isArray(options.copy)) {
        let promises = [];
        for (let cp of options.copy) {
          if (typeof cp === "string") {
            promises.push(helper.recursiveCopy(cp));
          } else if (cp.from && cp.to) {
            promises.push(helper.recursiveCopy(cp.from, cp.to, cp.options));
          } else {
            debug(
              "Ignored extra copy %o (needs to be a string or a {from: '', to: ''})",
              cp
            );
          }
        }
        await Promise.all(promises);
      }

      console.log(
        `Eleventy Serverless: ${helper.copyCount} file${
          helper.copyCount !== 1 ? "s" : ""
        } bundled to ${helper.getOutputPath("")}.`
      );
    });

    eleventyConfig.on("eleventy.env", async (env) => {
      await helper.ensureDir();

      if (options.copyEnabled) {
        helper.copyFile(env.config, "eleventy.config.js");

        helper.writeDependencyConfigFile(env.config);
      }
    });

    eleventyConfig.on("eleventy.globalDataFiles", (fileList) => {
      helper.writeDependencyGlobalDataFile(fileList);
    });

    eleventyConfig.on("eleventy.directories", async (dirs) => {
      if (!options.copyEnabled) {
        return;
      }

      let promises = [];
      promises.push(helper.recursiveCopy(dirs.data));
      promises.push(helper.recursiveCopy(dirs.includes));
      if (dirs.layouts) {
        promises.push(helper.recursiveCopy(dirs.layouts));
      }
      await Promise.all(promises);
    });

    eleventyConfig.on("eleventy.serverlessUrlMap", (templateMap) => {
      let outputMap = {};

      for (let entry of templateMap) {
        for (let key in entry.serverless) {
          if (key !== options.name) {
            continue;
          }
          let urls = entry.serverless[key];
          if (!Array.isArray(urls)) {
            urls = [entry.serverless[key]];
          }
          for (let eligibleUrl of urls) {
            // ignore duplicates that have the same input file, via Pagination.
            if (outputMap[eligibleUrl] === entry.inputPath) {
              continue;
            }

            if (outputMap[eligibleUrl]) {
              throw new Error(
                `Serverless URL conflict: multiple input files are using the same URL path (in \`permalink\`): ${outputMap[eligibleUrl]} and ${entry.inputPath}`
              );
            }

            outputMap[eligibleUrl] = entry.inputPath;
          }
        }
      }

      // Maps input files to output paths
      let mapEntryCount = Object.keys(outputMap).length;
      // This is expected to exist even if empty
      let filename = helper.getOutputPath("eleventy-serverless-map.json");
      fs.writeFileSync(filename, JSON.stringify(outputMap, null, 2));
      debug(
        `Eleventy Serverless (${options.name}), writing (×${mapEntryCount}): ${filename}`
      );
      this.copyCount++;

      // Write redirects (even if no redirects exist for this function to handle deletes)
      if (options.copyEnabled && options.redirects) {
        if (
          typeof options.redirects === "string" &&
          redirectHandlers[options.redirects]
        ) {
          redirectHandlers[options.redirects](options.name, outputMap);
        } else if (typeof options.redirects === "function") {
          options.redirects(options.name, outputMap);
        }
      }

      if (options.copyEnabled && mapEntryCount > 0) {
        // Copy templates to bundle folder
        for (let url in outputMap) {
          helper.recursiveCopy(outputMap[url]);
        }
      }
    });
  }
}

module.exports = EleventyPlugin;
