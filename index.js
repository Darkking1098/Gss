#!/usr/bin/env node

import fs from "fs";
import path from "path";

let configs,
    runConfig = { files: {} };

const REGEX = {
    color: /@col\/([\w-]+)/g,
};

const base_path = (subPath = null) =>
    path.join(process.cwd(), subPath).replace(/\\/g, "/");

const readDir = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).reduce((acc, file) => {
        const filePath = base_path(path.join(dir, file));
        const stats = fs.statSync(filePath);
        if (path.extname(file) === ".gss") {
            acc[filePath] = {
                file: base_path(file),
                cPath: base_path(
                    configs.output + file.replace(/\.gss$/, ".json")
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
        if (!Array.isArray(prop)) {
            prop = prop.includes(":")
                ? prop.split(":").map((x) => x.trim())
                : prop.includes("-")
                ? prop.split("-").map((x) => x.trim())
                : [prop];
        }

        if (prop[0].startsWith("@")) {
            prop[0] = prop[0]
                .slice(1)
                .split("-")
                .map((x) => configs.shorts[x])
                .join("-");
        }

        prop[1] = prop[1].replace(REGEX.color, (_, value) => resolveCol(value));
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
}


const prepareContent = (content) => {
    content = (
        Array.isArray(content)
            ? content
            : content.replace(/\t/g, "    ").split("\n")
    ).filter((x) => x.trim());

    const spaces = content[0]?.match(/^ +/)?.[0].length || 0;

    return content.map((x) => x.substr(spaces));
};

const createBlocks = (content) => {
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
                    temp[0] == "&" ||
                    !temp.match(/[.#@:&]/) ||
                    (temp[0].match(/[.#@:&]/) &&
                        !temp.match(/@([^:\s]+)\s*:\s*([^:\s]+)/))
                ) {
                    let temp = [];
                    while (content.length >= 0 && (!line || line.match(REG))) {
                        temp.push(line);
                        line = content.shift();
                        if (!line) break;
                    }
                    if (line) content.unshift(line);
                    block.addChildren(createBlocks(temp));
                } else {
                    block.addProps(line);
                }
            } else {
                if (line.trim()) {
                    if (block) blocks.push(block);
                    block = new Block(line);
                }
            }
        } else if (content.length == 0) {
            if (block) blocks.push(block);
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

const compileBlock = (block) => {
    if (block.selector == "@def") {
        block.props.forEach(([key, prop]) => {
            configs.shorts[key] = prop;
        });
        for (const short in configs.shorts) {
            let val = configs.shorts[short];
            if (!val.includes("@")) continue;
            let matches = [...val.matchAll(/@(\w+)/g)];
            matches.forEach((match) => {
                let key = match[1];
                val = val.replace(`@${key}`, configs.shorts[key]);
            });
            configs.shorts[short] = val;
        }
    } else if (block.selector == "@col") {
        block.props.forEach(([key, prop]) => {
            configs.colors[key] = setColorProp(prop);
        });
    }
};

const compile = (origin, destination) => {
    let blocks = createBlocks(readFile(origin));

    blocks.forEach((block) => {
        compileBlock(block);
    });

    let content = "";
    writeFile(destination, JSON.stringify(blocks));
};

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

const readConfig = () => {
    const configFile = "config.json";
    configs = fs.existsSync(configFile)
        ? JSON.parse(readFile(configFile))
        : {
              dirs: ["gss"],
              output: "css/",
              removeDeleted: false,
              files: {},
              colors: {},
              shorts: {},
              variables: {},
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
