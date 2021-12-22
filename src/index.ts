import assert from "assert";
import {existsSync} from "fs";
import {mkdir, readdir, readFile, stat, writeFile} from "fs/promises";
import {dirname, join, relative, resolve, sep as pathSeparator} from "path";
import Ajv from "ajv";
import {stripIndent} from "common-tags";
import createDebug from "debug";
import deepmerge from "deepmerge";
import execa from "execa";
import inquirer, {DistinctChoice} from "inquirer";
import validatePackageName from "validate-npm-package-name";
import configSchema from "./schemas/config";
import templateSchema from "./schemas/template";
import {groupBy} from "./utils/groupBy";
import customResultSchema from "./schemas/custom-result";

const {prompt} = inquirer;
const debug = createDebug("crpml");

type ResolveFunction = (name: string) => string;

interface Config {
    outDir?: string;
    scope?: string;
}

interface TemplateVariant {
    displayName: string;
    description?: string;
    required?: boolean;
    scripts?: string[];
    files: string[];
}

interface TemplateFiles {
    mergeMethod: `custom:${string}` | "json" | "json-shallow" | "last";
}

interface Template {
    displayName: string;
    description?: string;
    variants: Record<string, TemplateVariant>;
    files: Record<string, TemplateFiles>;
}

interface LoadedTemplate extends Template {
    id: string;
    directory: string;
    variantFiles: Record<string, Record<string, string>>;
}

interface LoadedConfig {
    directory: string;
    config: Config;
    templates: Record<string, LoadedTemplate>;
}

// replaces the inner parts of a path with an ellipsis
function getShortPathName(absolutePath: string) {
    const endsWithSlash = absolutePath.endsWith(pathSeparator);
    const normalisedPath = endsWithSlash
        ? absolutePath.substring(0, absolutePath.length - 1)
        : absolutePath;

    const parts = normalisedPath.split(pathSeparator);
    if (parts.length < 7) return absolutePath;

    // the empty value before the first slash is included in count
    const firstParts = parts.slice(0, 4);
    const lastParts = parts.slice(-3);

    const result = [...firstParts, "...", ...lastParts].join(pathSeparator);

    if (endsWithSlash) return result + "/";
    return result;
}

/**
 * Returns the .crpml directory containing the configuration files
 */
async function findConfig() {
    let directory = process.cwd();
    let previousDirectory = directory;

    do {
        const files = await readdir(directory);

        if (files.includes(".crpml")) {
            const crpmlPath = resolve(directory, ".crpml");
            const stats = await stat(crpmlPath);

            assert(
                stats.isDirectory(),
                `Found .crpml that is not a directory, in ${directory}`
            );

            return crpmlPath;
        }

        previousDirectory = directory;
        directory = dirname(directory);
    } while (previousDirectory !== directory);

    throw new Error("Could not find create-rpm-library configuration");
}

async function readConfigFile(ajv: Ajv, path: string) {
    assert(
        existsSync(path),
        "config.json is missing in create-rpm-library configuration"
    );
    const source = await readFile(path, "utf8");
    const config = JSON.parse(source);

    const isValid = ajv.compile<Config>(configSchema);

    assert(
        isValid(config),
        `Invalid configuration: ${isValid.errors
            ?.map(err => err.message)
            .join(", ")}`
    );

    return config;
}

async function readTemplates(
    ajv: Ajv,
    dir: string
): Promise<Record<string, LoadedTemplate>> {
    assert(
        existsSync(dir),
        "templates directory is missing in create-rpm-library configuration"
    );

    const isValid = ajv.compile<Template>(templateSchema);

    const templateDirectories = await readdir(dir);
    const result = new Map<string, LoadedTemplate>();
    const usedTemplateDisplayNames = new Set<string>();

    for (const id of templateDirectories) {
        debug(`Loading template ${id}`);

        const templateDirectory = resolve(dir, id);
        const stats = await stat(templateDirectory);

        assert(stats.isDirectory(), `invalid template ${id}: not a directory`);

        const configPath = join(templateDirectory, "template.json");
        assert(
            existsSync(configPath),
            `Invalid template \`${id}\`: template.json does not exist`
        );

        const templateConfigSource = await readFile(configPath, "utf8");
        const templateConfig = JSON.parse(templateConfigSource);

        assert(
            isValid(templateConfig),
            `Invalid template \`${id}\`: invalid configuration: ${isValid.errors
                ?.map(err => err.message)
                .join(", ")}`
        );

        assert(
            !usedTemplateDisplayNames.has(templateConfig.displayName),
            `Invalid template \`${id}\`: duplicate display name`
        );
        usedTemplateDisplayNames.add(templateConfig.displayName);

        const variantFiles = new Map<string, Record<string, string>>();
        const usedVariantDisplayNames = new Set<string>();

        for (const [variantId, variant] of Object.entries(
            templateConfig.variants
        )) {
            const variantLabel = `variant \`${variantId}\` for template \`${id}\``;
            debug(`Loading ${variantLabel}`);

            assert(
                !usedVariantDisplayNames.has(variant.displayName),
                `Invalid ${variantLabel}: the display name is already being used`
            );
            usedVariantDisplayNames.add(variant.displayName);

            const variantDirectory = join(templateDirectory, variantId);
            assert(
                existsSync(variantDirectory),
                `Invalid ${variantLabel}: its directory does not exist`
            );

            const directoryStats = await stat(variantDirectory);
            assert(
                directoryStats.isDirectory(),
                `Invalid ${variantLabel}: its directory is not a directory`
            );

            const files = Object.fromEntries(
                await Promise.all(
                    variant.files.map(async path => {
                        const resolvedPath = join(variantDirectory, path);

                        assert(
                            existsSync(resolvedPath),
                            `Invalid ${variantLabel}: the file ${path} doesn't exist`
                        );

                        return [path, await readFile(resolvedPath, "utf8")] as [
                            string,
                            string
                        ];
                    })
                )
            );

            variantFiles.set(variantId, files);
        }

        result.set(id, {
            ...templateConfig,
            id,
            directory: templateDirectory,
            variantFiles: Object.fromEntries(Array.from(variantFiles.entries()))
        });
    }

    return Object.fromEntries(Array.from(result.entries()));
}

async function loadConfig(): Promise<LoadedConfig> {
    const ajv = new Ajv();
    const directory = await findConfig();
    debug("Discovered workspace root at", directory);

    const config = await readConfigFile(ajv, join(directory, "config.json"));
    const templates = await readTemplates(ajv, join(directory, "templates"));

    return {
        directory: dirname(directory),
        config,
        templates
    };
}

function getFullName(config: Config, input: string) {
    if (config.scope) return `${config.scope}/${input}`;
    return input;
}

function getOutputDirectory(
    resolve: ResolveFunction,
    config: Config,
    packageName: string
) {
    return resolve(`${config.outDir ?? process.cwd()}/${packageName}`);
}

function isCustomMergeMethod(
    mergeMethod: string
): mergeMethod is `custom:${string}` {
    return mergeMethod.startsWith("custom:");
}

interface SourceFileInfo {
    variant: string;
    sourceText: string;
}

interface MergedFileInfo {
    contributingVariants: string[];
    sourceText: string;
}

async function mergeFiles(
    template: LoadedTemplate,
    path: string,
    sources: SourceFileInfo[]
): Promise<MergedFileInfo> {
    if (sources.length === 0) {
        throw new Error("Sources length is zero. This shouldn't happen D:");
    }

    if (sources.length === 1) {
        return {
            contributingVariants: [sources[0].variant],
            sourceText: sources[0].sourceText
        };
    }

    const mergeMethod = template.files[path]?.mergeMethod;
    assert(mergeMethod, `Missing merge method for ${path}`);

    debug(`Merging ${sources.length} sources for ${path}`);
    if (mergeMethod === "json") {
        const jsonSources = sources.map(source => JSON.parse(source.sourceText));
        const merged = deepmerge.all(jsonSources);
        return {
            contributingVariants: sources.map(source => source.variant),
            sourceText: JSON.stringify(merged, null, 2)
        };
    } else if (mergeMethod === "json-shallow") {
        const jsonSources = sources.map(source => JSON.parse(source.sourceText));
        const merged = Object.assign({}, ...jsonSources);
        return {
            contributingVariants: sources.map(source => source.variant),
            sourceText: JSON.stringify(merged, null, 2)
        };
    } else if (mergeMethod === "last") {
        const source = sources[sources.length - 1];
        return {
            contributingVariants: [source.variant],
            sourceText: source.sourceText
        };
    } else if (isCustomMergeMethod(mergeMethod)) {
        const customMerger = mergeMethod.substring("custom:".length);
        const modulePath = join(template.directory, customMerger);
        const {default: module} = await import(modulePath);
        assert(
            typeof module === "function",
            `Invalid custom merger \`${customMerger}\`: default export is not a function`
        );
        const result = module(sources);

        const ajv = new Ajv();
        const isValid = ajv.compile(customResultSchema);

        assert(
            isValid(result),
            `Invalid custom merger \`${customMerger}\`: invalid result: ${isValid.errors
                ?.map(err => err.message)
                .join(", ")}`
        );

        if (typeof result === "string") {
            return {
                contributingVariants: sources.map(source => source.variant),
                sourceText: result
            }
        } else {
            return result;
        }
    }

    throw new Error(`Invalid merge method for ${path}`);
}

// https://stackoverflow.com/a/31102605
function sortByKeys<T extends Record<string, unknown>>(src: T): T {
    return Object.keys(src)
        .sort()
        .reduce((obj, key: keyof T) => {
            obj[key] = src[key];
            return obj;
        }, {} as T);
}

function getScripts(template: LoadedTemplate, selectedVariants: string[]) {
    return Object.entries(template.variants)
        .filter(([k]) => selectedVariants.includes(k))
        .flatMap(([, v]) => v.scripts ?? []);
}

interface PromptResult {
    packageName: string;
    template: string;
    variants: string[];
    isSaveLocationOk: boolean;
    packageManager: "pnpm" | "npm" | "yarn" | string | false;
    createJetbrainsRunConfigurations: boolean;
}

function getVariantIdsWithRequired(
    variantIds: string[],
    template: LoadedTemplate
) {
    return [
        ...variantIds,
        ...Object.entries(template.variants)
            .filter(([, v]) => v.required)
            .map(([k]) => k)
    ];
}

interface DirectoryTreeItem {
    /**
     * The path to the file, split by directories (e.g. path/to/file.txt == [path, to, file.txt])
     */
    path: string[];

    /**
     * The display names of the variants that contributed to this file
     */
    sourceVariants: string[];
}

function getDisplayFileName(thisFileName: string, subFilePaths: DirectoryTreeItem[]) {
    const parts = [thisFileName];
    let nextGroup = subFilePaths;

    while (nextGroup.length > 0) {
        const nextDirectories = groupBy(nextGroup, name => name.path[0]);

        if (nextDirectories.size > 1) {
            return {
                displayPath: parts,
                isDisplayingFile: false,
                displayVariants: null,
                childFiles: nextGroup
            };
        }

        const [nextDirectoryName, nextDirectoryItems] = Array.from(nextDirectories.entries())[0];

        parts.push(nextDirectoryName);

        const filteredFiles = nextDirectoryItems
            .map(file => ({...file, path: file.path.slice(1)}))
            .filter(el => el.path.length > 0);

        if (filteredFiles.length === 0) {
            const variants = nextGroup[0].sourceVariants;

            return {
                displayPath: parts,
                isDisplayingFile: true,
                displayVariants: variants,
                childFiles: []
            }
        } else {
            nextGroup = filteredFiles;
        }
    }

    return {
        displayPath: parts,
        isDisplayingFile: true,
        displayVariants: null,
        childFiles: []
    }
}

function logDirectoryTree(fileNames: DirectoryTreeItem[], separator = "/", level = 0, padding = "", maxLength = -1) {
    maxLength = maxLength === -1
        ? fileNames.map(name => name.path.slice(-1)[0].length + name.path.length * 2).reduce((prev, curr) => Math.max(curr, prev), 0)
        : maxLength;

    const directories = groupBy(fileNames, name => name.path[0]);
    const directoryEntries = Array.from(directories);

    for (let i = 0; i < directoryEntries.length; i++) {
        const [thisFileName, files] = directoryEntries[i];

        const newFilePaths = files
            .map(file => ({...file, path: file.path.slice(1)}))
            .filter(el => el.path.length > 0);

        const {displayPath, isDisplayingFile, displayVariants, childFiles} = getDisplayFileName(thisFileName, newFilePaths);

        const isFirst = i === 0;
        const isLast = i === directories.size - 1;
        const isDirectory = !isDisplayingFile && childFiles.length > 0;

        const lineCharacter = isFirst && isLast ? "╶" : isFirst ? "╭" : isLast ? "╰" : "├";

        const subPadding = padding + (isLast ? "  " : "│ ");

        const lineLength = padding.length + 2 + displayPath.join("/").length;
        const endPadding = !isDirectory && " ".repeat(maxLength - lineLength + 2);

        const fileVariant = displayVariants?.join(", ") || files[0]?.sourceVariants.join(", ");
        const endText = isDirectory ? "" : `${endPadding}\x1b[90m(${fileVariant})\x1b[39m`;

        console.log(`\x1b[90m${padding}${lineCharacter}\x1b[39m \x1b[${isDirectory || displayPath.length > 0 ? "94" : "92"}m${displayPath.slice(0, -1).join("/")}${displayPath.length > 1 ? "/" : ""}${isDirectory ? "" : "\x1b[92m"}${displayPath.slice(-1)[0]}\x1b[39m${endText}`);
        logDirectoryTree(childFiles, separator, level + 1, subPadding, maxLength);
    }
}

async function run() {
    const config = await loadConfig();

    function resolveRelative(path: string) {
        return resolve(config.directory, path);
    }

    const {
        packageName,
        template: templateId,
        variants: variantIds,
        isSaveLocationOk,
        packageManager,
        createJetbrainsRunConfigurations
    } = await prompt<PromptResult>([
        {
            type: "input",
            name: "packageName",
            message: "What should the package be called?",
            transformer(input: string) {
                return getFullName(config.config, input);
            },
            validate(input: string) {
                const packageName = getFullName(config.config, input);
                const isValid = validatePackageName(packageName);

                if (isValid.validForNewPackages) {
                    const dir = getOutputDirectory(
                        resolveRelative,
                        config.config,
                        input
                    );

                    if (existsSync(dir)) {
                        return "Output directory already exists";
                    } else {
                        return true;
                    }
                }

                return isValid.errors?.join(", ") ?? false;
            }
        },
        {
            type: "list",
            name: "template",
            message: "Which template should the library be based on?",
            choices: Object.values(config.templates).map(v => ({
                name: v.description
                    ? `${v.displayName} - ${v.description}`
                    : v.displayName,
                short: v.displayName,
                value: v.id
            }))
        },
        {
            type: "checkbox",
            name: "variants",
            message: ({template}) =>
                `Select the variants you wish to apply to ${config.templates[template].displayName}`,
            choices: ({template}) =>
                Object.entries(config.templates[template].variants).map(
                    ([id, variant]) => ({
                        name: variant.description
                            ? `${variant.displayName} - ${variant.description}`
                            : variant.displayName,
                        short: variant.displayName,
                        value: id,
                        disabled: variant.required && "Required"
                    })
                )
        },
        {
            type: "list",
            name: "packageManager",
            message:
                "Select the package manager to use to install the dependencies",
            choices: () => {
                const base: DistinctChoice[] = [
                    "pnpm",
                    "npm",
                    "yarn",
                    {
                        name: "Don't install the dependencies for me",
                        value: false
                    }
                ];

                debug("npm_execpath is %s", process.env.npm_execpath);

                if ("npm_execpath" in process.env) {
                    const execPath = process.env.npm_execpath as string;

                    if (existsSync(execPath)) {
                        base.unshift({
                            name: `Current (${getShortPathName(execPath)})`,
                            value: execPath
                        });
                    }
                }

                return base;
            }
        },
        {
            type: "confirm",
            name: "createJetbrainsRunConfigurations",
            when: ({template, variants}) =>
                getScripts(
                    config.templates[template],
                    getVariantIdsWithRequired(
                        variants,
                        config.templates[template]
                    )
                ).length > 0 && existsSync(join(config.directory, ".idea")),
            message: "Create JetBrains run configurations?"
        },
        {
            type: "confirm",
            name: "isSaveLocationOk",
            message: ({packageName}) =>
                `Save to ${relative(
                    dirname(config.directory),
                    getOutputDirectory(
                        resolveRelative,
                        config.config,
                        packageName
                    )
                )}?`
        }
    ]);

    if (!isSaveLocationOk) return;

    const saveLocation = getOutputDirectory(
        resolveRelative,
        config.config,
        packageName
    );

    assert(!existsSync(saveLocation), "Output directory already exists");

    debug("Creating output directory");
    await mkdir(saveLocation);

    const template = config.templates[templateId];

    const variantIdsWithRequired = getVariantIdsWithRequired(
        variantIds,
        template
    );

    const appliedVariantFiles = Object.entries(template.variantFiles).filter(
        ([k]) => variantIdsWithRequired.includes(k)
    );

    // map of file names to the various source files
    const files = new Map<string, SourceFileInfo[]>();

    for (const [variantName, variantFiles] of appliedVariantFiles) {
        for (const [path, source] of Object.entries(variantFiles)) {
            const arr = files.get(path) ?? [];
            if (!files.has(path)) files.set(path, arr);
            arr.push({variant: variantName, sourceText: source});
        }
    }

    const fileVariants = new Map<string, string[]>();

    for (const [path, sources] of files) {
        if (path === "package.json") {
            sources.unshift(
                {
                    variant: "internal.node",
                    sourceText: JSON.stringify({
                        name: getFullName(config.config, packageName),
                        version: "0.1.0"
                    })
                }
            );
        }

        let fileSource = await mergeFiles(template, path, sources);
        fileVariants.set(path, fileSource.contributingVariants);

        if (path === "package.json") {
            const fileSourceJson = JSON.parse(fileSource.sourceText);

            if (fileSourceJson.dependencies) {
                fileSourceJson.dependencies = sortByKeys(
                    fileSourceJson.dependencies
                );
            }

            if (fileSourceJson.devDependencies) {
                fileSourceJson.devDependencies = sortByKeys(
                    fileSourceJson.devDependencies
                );
            }

            if (fileSourceJson.peerDependencies) {
                fileSourceJson.peerDependencies = sortByKeys(
                    fileSourceJson.peerDependencies
                );
            }

            if (fileSourceJson.optionalDependencies) {
                fileSourceJson.optionalDependencies = sortByKeys(
                    fileSourceJson.optionalDependencies
                );
            }

            fileSource.sourceText = JSON.stringify(fileSourceJson, null, 2);
        }

        const outputPath = join(saveLocation, path);

        debug(`Creating ${path}`);
        await mkdir(dirname(outputPath), {recursive: true});
        await writeFile(outputPath, fileSource.sourceText);
    }

    if (createJetbrainsRunConfigurations) {
        const scripts = getScripts(template, variantIdsWithRequired);
        const relativeProjectDir = relative(config.directory, saveLocation);

        for (const script of scripts) {
            debug(`Creating JetBrains run configuration for ${script}`);

            const name = `${packageName}:${script}`;

            // language=xml
            const xml = stripIndent`
                <component name="ProjectRunConfigurationManager">
                    <configuration default="false" name="${name}" type="js.build_tools.npm">
                        <package-json value="$PROJECT_DIR$/${relativeProjectDir}/package.json"/>
                        <command value="run"/>
                        <scripts>
                            <script value="${script}"/>
                        </scripts>
                        <node-interpreter value="project"/>
                        <method v="2"/>
                    </configuration>
                </component>`;

            const path = join(
                config.directory,
                ".idea",
                "runConfigurations",
                name.replace(/[^a-zA-Z0-9]+/g, "_") + ".xml"
            );

            await mkdir(dirname(path), {recursive: true});
            await writeFile(path, xml);
        }
    }

    if (packageManager && files.has("package.json")) {
        debug(`Installing dependencies using ${packageManager}...`);

        await execa(packageManager, ["install"], {
            stderr: "inherit",
            stdout: "inherit",
            cwd: saveLocation
        });
    }

    console.log("\n\nGenerated file tree:");
    logDirectoryTree(Array.from(files.keys()).map(path => {
        const variants = fileVariants.get(path);
        assert(variants, `No variants set for \`${path}\``);

        return ({
            path: join(saveLocation, path).split("/"),
            sourceVariants: variants
        });
    }));
}

run().catch((err: Error) => {
    console.error(`\x1b[36mOops, something went wrong! \x1b[31m${err.message.replace(/`([^`]+)`/g, "`\x1b[31;1m$1\x1b[0m\x1b[31m`")}\x1b[0m`);
});
