export default {
    type: "object",
    required: ["displayName", "variants"],
    properties: {
        displayName: {
            type: "string",
            description: "The name that this template will be given in the CLI"
        },
        description: {
            type: "string",
            description:
                "A short description to display beside the display name"
        },
        variants: {
            type: "object",
            description:
                "Any variants that the user can pick from to build the library",
            minProperties: 1,
            additionalProperties: {
                type: "object",
                properties: {
                    displayName: {
                        type: "string",
                        description:
                            "The name that this template will be given in the CLI"
                    },
                    description: {
                        type: "string",
                        description:
                            "A short description to display beside the display name"
                    },
                    required: {
                        type: "boolean",
                        description:
                            "If this value is `true`, the user will not be able to disable this variant"
                    },
                    scripts: {
                        type: "array",
                        description:
                            "A list of scripts that this template adds to the package.json",
                        items: {
                            type: "string"
                        }
                    },
                    files: {
                        type: "array",
                        description:
                            "Any files that should be copied, relative to this variant's directory. Note that, if the file is `package.json`, the `name` field will be overwritten.",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["displayName", "files"]
            }
        },
        files: {
            type: "object",
            description: "Configuration for each output file",
            additionalProperties: {
                type: "object",
                properties: {
                    mergeMethod: {
                        description:
                            "Specifies how to merge multiple versions of the file from each variant",
                        oneOf: [
                            {
                                type: "string",
                                const: "json",
                                description:
                                    "Deeply merges the files, assuming they are JSON"
                            },
                            {
                                type: "string",
                                const: "json-shallow",
                                description:
                                    "Shallowly merges the files, assuming they are JSON"
                            },
                            {
                                type: "string",
                                const: "last",
                                description: "Uses the last version of the file"
                            },
                            {
                                type: "string",
                                description:
                                    "Uses a custom script to merge the files. The script must have a default export of a function that takes an array of the source text of each file, and returns the text of the output file",
                                pattern: "^custom:"
                            }
                        ]
                    }
                }
            }
        }
    }
};
