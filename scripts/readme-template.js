import {readFileSync, writeFileSync} from "fs";
import {dirname, resolve} from "path";
import {fileURLToPath, pathToFileURL} from "url";

function template(src, obj) {
    const regex = /<!--BEGIN (?<name>[a-z_.]+)(?<args>.+?)?-->.+?<!--END-->/gi;

    return src.replace(regex, (_, name, args) => {
        const argsParsed = JSON.parse(`[${args}]`);
        const result = typeof obj[name] === "function" ? obj[name](...argsParsed) : obj[name];

        const argsJoined = JSON.stringify(argsParsed);
        const argsStringified = argsJoined.substring(1, argsJoined.length - 1);

        return `<!--BEGIN ${name}${argsStringified}-->${result} <!--END-->`;
    });
}

const directory = dirname(fileURLToPath(import.meta.url));

const {version} = JSON.parse(readFileSync(resolve(directory, "../package.json"), "utf8"));

const source = readFileSync(resolve(directory, "../README.md"), "utf8");
const replaced = template(source, {
    SCHEMA_URL(name) {
        return `https://rad.gd/dev/crpml@${version}/${name}.schema.json`;
    }
});

console.log("Writing updated readme");
writeFileSync(resolve(directory, "../README.md"), replaced);
