#!/usr/bin/env node

import fs from "fs";
import path from "path";

let configs,
    runConfig = { files: {} };

const specialSelectors = ["@def", "@col", "@var", "@use", "@container"];

const REGEX = {
    double_slash: /\\/g,
    gss_ext: /\.gss$/,
    color: /@col\/([\w-]+)/g,
};

function startsWithAny(str, arr) {
    return arr.some((prefix) => str.startsWith(prefix));
}

const base_path = (subPath = null) =>
    path.join(process.cwd(), subPath).replace(REGEX.double_slash, "/");

const readDir = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).reduce((acc, file) => {
        const filePath = base_path(path.join(dir, file));
        const stats = fs.statSync(filePath);
        if (path.extname(file) === ".gss") {
            acc[filePath] = {
                file: base_path(`${dir}/${file}`),
                cPath: base_path(
                    configs.output + file.replace(REGEX.gss_ext, ".css")
                ),
                mtime: String(stats.mtime),
            };
        }
        return acc;
    }, {});
};

const validateArray = (item) => (Array.isArray(item) ? item : [item]);

const readFile = (file) => fs.readFileSync(file, "utf8");

const writeFile = (file, data) => fs.writeFileSync(file, data, "utf8");

const deleteFile = (file) => fs.unlinkSync(file);

const resolveCol = (color) => {
    let temp = color.split("-");
    return `rgba(${configs.colors[temp[0]]},${(temp[1] ?? 100) / 100})`;
};

function createRegex(pattern) {
    return new RegExp(
        "^" +
            pattern.replace(/{\w+}/g, "([^\\-]+)").replace(/[-{}]/g, "\\$&") +
            "$"
    );
}
function findMatch(input) {
    let patterns = configs.containers;
    for (const pattern of Object.keys(patterns)) {
        const regexPattern = pattern
            .replace(/{\w+}/g, "([^/]+)")
            .replace(/\//g, "\\/");

        const regex = new RegExp(`^${regexPattern}$`);
        const match = input.match(regex);

        if (match) {
            const keys = (pattern.match(/{\w+}/g) || []).map((key) =>
                key.slice(1, -1)
            );
            const values = match.slice(1);

            let replacement = patterns[pattern];

            // Replace placeholders in the replacement string
            keys.forEach((key, index) => {
                const value = values[index];
                const placeholder = `{${key}}`;
                replacement = replacement.replace(
                    new RegExp(placeholder, "g"),
                    value
                );
            });

            return replacement;
        }
    }
}

class Block {
    constructor(selector, props = [], children = [], extra = {}) {
        this.selector = selector;
        this.props = props;
        this.children = children;
        this.extra = extra;
        this.resolveSelector();
    }

    resolveSelector() {
        let [base, extend] = this.selector.split("++");
        let baseParts = base.split(/(?=@)/).map((s) => s.trim());
        this.selector = baseParts.shift();
        baseParts.forEach(this.addProps.bind(this));
        this.addExtend(extend);
    }

    addProps(prop) {
        prop = prop.trim();
        let match;
        if (prop.trim().startsWith("@fun")) {
            prop = prop.slice(5);
            if ((match = prop.match(/(\w+)\(([^)]*)\)/))) {
                let functionName = match[1];
                let variables = match[2]
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean);
                let fxn = configs.functions[functionName];
                let prepared = Object.keys(fxn.variables).reduce(
                    (acc, key, i) => {
                        acc[key] = variables[i] ?? fxn.variables[key];
                        return acc;
                    },
                    {}
                );
                fxn.props.forEach(([prop, val]) => {
                    this.addProps(
                        `${prop}:` +
                            val.replace(
                                /\$(\w+)/g,
                                (match, key) => prepared[`$${key}`]
                            )
                    );
                });
                return;
            }
        }
        if (!Array.isArray(prop)) {
            prop = prop.includes(":")
                ? prop.split(/:(.*)/s).map((x) => x.trim())
                : prop.includes("-")
                ? prop.split("-").map((x) => x.trim())
                : [prop];
        }
        prop.filter((x) => x.trim());

        if (this.selector === "@use") {
            prop[0] = prop[0].slice(1);
        } else if (this.selector === "@container") {
        } else if (prop[0].startsWith("@")) {
            prop[0] = prop[0].replace(/@([\w-]+)/g, (match, p1) => {
                return p1
                    .split("-")
                    .map((x) => configs.shorts[x])
                    .join("-");
            });
        }

        prop[1] = prop[1].replace(REGEX.color, (_, value) => resolveCol(value));
        let raw = prop[1]
            .trim()
            .split(" ")
            .map((x) => x.trim())
            .filter(Boolean);
        prop[1] = raw.shift();

        raw.forEach((elem) => {
            if (elem[0] != "@") {
                prop[1] += ` ${elem}`;
                return;
            }
            elem = elem.slice(1);
            let splitted = elem.split("-");
            let pshudo = configs.pshudo[splitted[0]];
            if (pshudo) {
                let block = new Block(pshudo);
                prop[0]
                    .split(",")
                    .forEach((x) => block.props.push([x.trim(), splitted[1]]));
                this.children.push(block);
            } else {
                let match = findMatch(elem.split("-")[0]);
                if (!match) return;
                let block = new Block(match);
                let inner = new Block(this.selector);
                prop[0]
                    .split(",")
                    .forEach((x) => inner.props.push([x.trim(), splitted[1]]));
                block.addChildren([inner]);

                this.children.push(block);
            }
        });
        prop[0].split(",").forEach((x) => this.props.push([x.trim(), prop[1]]));
    }

    addChildren(children) {
        this.children.push(...children);
    }

    addExtend(extend) {
        if (!Array.isArray(extend)) {
            extend = extend ? extend.split(",").map((s) => s.trim()) : [];
        }
        this.extra.extend = this.extra.extend
            ? [...new Set([...this.extra.extend, ...extend])]
            : extend;
    }

    toCSS(parent = "") {
        let selector = parent;
        let props = "";
        let children = "";
        if (this.selector.startsWith("&")) {
            selector += this.selector.slice(1);
        } else if (this.selector.startsWith(":")) {
            selector += this.selector;
        } else {
            selector += " " + this.selector;
        }
        selector = selector.trim();

        this.props.forEach(([p, v]) => {
            props += `${p}:${v};`;
        });

        this.children.forEach((child) => {
            if (child.selector[0] == "@" || this.selector[0] == "@") {
                children += child.toCSS();
            } else {
                children += child.toCSS(selector);
            }
        });

        if (selector[0] == "@") {
            return `${selector} { ${children} }`;
        } else {
            if (props.trim()) {
                return `${selector} { ${props} } ${children}`;
            } else {
                return children;
            }
        }
    }
}

const objectToCss = (obj) =>
    Object.entries(obj)
        .map(([key, value]) =>
            typeof value === "object" && !Array.isArray(value)
                ? `${key} { ${objectToCss(value)} }`
                : Object.entries(obj)
                      .map(
                          ([styleKey, styleValue]) =>
                              `${styleKey
                                  .replace(/([a-z])([A-Z])/g, "$1-$2")
                                  .toLowerCase()}: ${styleValue};`
                      )
                      .join(" ")
        )
        .join(" ");

const prepareContent = (content) => {
    content = (
        Array.isArray(content)
            ? content
            : content.replace(/\t/g, "    ").split("\n")
    ).filter((x) => x.trim());

    const spaces = content[0]?.match(/^ +/)?.[0].length || 0;

    return content.map((x) => x.substr(spaces));
};

const createBlocks = (content, nested = false) => {
    content = prepareContent(content);

    let blocks = [];
    let block = null;

    while (content.length >= 0) {
        let line = content.shift();

        const REG = /^( {4}|\t)/;
        if (line) {
            if (line.match(REG)) {
                let temp = line.trim();
                if (
                    (temp[0] == "&" ||
                        !temp.match(/[.#@:&]/) ||
                        (temp[0].match(/[.#@:&]/) &&
                            !temp.match(/@([^:\s]+)\s*:\s*([^:\s]+)/))) &&
                    block.selector != "@use" &&
                    !temp.startsWith("@fun")
                ) {
                    let temp = [];
                    while (content.length >= 0 && (!line || line.match(REG))) {
                        temp.push(line);
                        line = content.shift();
                        if (!line) break;
                    }
                    if (line) content.unshift(line);
                    block.addChildren(createBlocks(temp, true));
                } else {
                    block.addProps(line);
                }
            } else {
                if (line.trim()) {
                    if (block) {
                        if (
                            !nested &&
                            startsWithAny(block.selector, specialSelectors)
                        ) {
                            compileBlock("def.gss", block);
                        } else blocks.push(block);
                    }
                    block = new Block(line);
                }
            }
        } else if (content.length == 0) {
            if (block) {
                if (
                    !nested &&
                    startsWithAny(block.selector, specialSelectors)
                ) {
                    compileBlock("def.gss", block);
                } else blocks.push(block);
            }
            block = null;
            break;
        }
    }
    return blocks;
};

const setColorProp = (color) => {
    let bigint = parseInt(color.substr(1), 16),
        r = (bigint >> 16) & 255,
        g = (bigint >> 8) & 255,
        b = bigint & 255;
    return `${r},${g},${b}`;
};

const compileBlock = (file, block) => {
    if (!block) return;

    if (block.selector == "@def") {
        block.props.forEach(([prop, val]) => {
            configs.shorts[prop] = val;
        });
        for (const short in configs.shorts) {
            let val = configs.shorts[short];
            if (val.includes("@")) {
                val = val.replace(/@(\w+)/g, (_, key) => configs.shorts[key]);
                configs.shorts[short] = val;
            }
        }
    } else if (block.selector == "@col") {
        block.props.forEach(([prop, val]) => {
            configs.colors[prop] = setColorProp(val);
        });
    } else if (block.selector.startsWith("@var")) {
        if (block.selector == "@var") {
            block.props.forEach(([prop, val]) => {
                configs.variables[prop] = val;
            });
        } else {
            const regex = /@var\s+(\w+)\(([^)]*)\)/;
            const match = block.selector.match(regex);
            const functionName = match[1];
            const variables = match[2]
                .split(",")
                .map((variable) => {
                    const [key, value] = variable
                        .split("=")
                        .map((x) => x.trim());
                    return { [key]: value ?? null };
                })
                .reduce((acc, obj) => {
                    return { ...acc, ...obj };
                }, {});

            configs.functions[functionName] = {
                variables,
                props: block.props,
            };
        }
    } else if (block.selector == "@use") {
        block.props.forEach(([prop, val]) => {
            configs.pshudo[prop] = val;
        });
    } else if (block.selector == "@container") {
        block.props.forEach(([prop, val]) => {
            configs.containers[prop] = val;
        });
    } else {
        return block.toCSS();
    }
};

const compile = (origin, destination) => {
    let blocks = createBlocks(readFile(origin));
    origin = path.basename(origin);
    let content = "";
    blocks.forEach((block) => {
        content += compileBlock(origin, block);
    });

    writeFile(destination, content);
};

const readConfig = () => {
    const configFile = "config.json";
    configs = fs.existsSync(configFile)
        ? JSON.parse(readFile(configFile) ?? "{}")
        : {
              dirs: ["gss"],
              output: "css/",
              removeDeleted: false,
              files: {},
              colors: {},
              shorts: {},
              containers: {},
              variables: {},
              functions: {},
              pshudo: {},
          };
};

const saveConfig = () => writeFile("config.json", JSON.stringify(configs));

const listFiles = (dirs) => {
    const files = {};
    const updated = [];
    const deleted = [];

    validateArray(dirs).forEach((dir) => {
        const list = readDir(dir);
        Object.assign(files, list);
        Object.entries(list).forEach(([filePath, details]) => {
            const x = configs.files[filePath];
            if (
                !x ||
                details.mtime !== x.mtime ||
                !fs.existsSync(details.cPath)
            ) {
                updated[filePath] = details.cPath;
            }
        });
    });

    Object.keys(configs.files).forEach((filePath) => {
        if (!files[filePath]) deleted.push(filePath);
    });

    runConfig.files = { updated, deleted };
    configs.files = files;
};

const __main__ = () => {
    readConfig();
    listFiles(configs.dirs);

    for (const file in runConfig.files.updated) {
        compile(file, runConfig.files.updated[file]);
    }

    saveConfig();
};

__main__();
