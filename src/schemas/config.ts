export default {
    type: "object",
    properties: {
        outDir: {
            type: "string",
            description:
                "The directory that any packages will be placed in, relative to the workspace root",
            nullable: true
        },
        scope: {
            type: "string",
            description:
                "The scope of any packages. This value is not included in the output directory.",
            pattern: "^@",
            nullable: true
        }
    }
};
