#!/usr/bin/env node

import { log } from "console";
import fs from "fs";
import path from "path";

let configs,
    runConfig = { files: {} };

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

class Block {
    constructor(selector, props = [], children = [], extra = {}) {
        this.selector = selector;
        this.props = props;
        this.children = children;
        this.extra = extra;
        this.resolveSelector();
    }
    resolveSelector() {
        let temp = this.selector;

        let [base, extend] = temp.split("++");
        base = base.split(/(?=@)/).map((s) => s.trim());
        this.selector = base.shift();

        if (base) base.map((x) => this.addProps(x));
        this.addExtend(extend);
    }
    addProps(prop) {
        if (!Array.isArray(prop) && prop.includes(":")) {
            prop = prop.split(":").map((x) => x.trim());
        } else if (prop.includes("-")) {
            prop = prop.split("-").map((x) => x.trim());
            // For any safety change
        }
        this.props.push(prop);
    }
    addChildren(children) {
        this.children = [...this.children, ...children];
    }
    addExtend(extend) {
        if (!Array.isArray(extend))
            extend = extend?.split(",").map((s) => s.trim()) ?? [];
        if (this.extra.extend) {
            this.extra.extend = [...new Set([...this.extra.extend, ...extend])];
        } else {
            this.extra.extend = extend;
        }
    }
}

const prepareContent = (content) => {
    if (!Array.isArray(content))
        content = content.replace(/\t/g, "    ").split("\n");

    content.filter((x) => x.trim());

    let spaces = 0;

    if ((spaces = content[0]?.match(/^ +/))) {
        spaces = spaces[0].length;
    } else spaces = 0;
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
                if (block) blocks.push(block);
                block = new Block(line);
            }
        } else {
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
            let matches = [...val.matchAll(/@([^@-]+)-/g)];
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
    // console.log(runConfig);

    for (const file in runConfig.files.updated) {
        compile(file, runConfig.files.updated[file]);
    }

    saveConfig();
};

__main__();
