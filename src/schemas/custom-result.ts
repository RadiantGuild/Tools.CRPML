import {JSONSchemaType} from "ajv";

type CustomResult = string | {
    contributingVariants: string[];
    sourceText: string;
};

const customResultSchema: JSONSchemaType<CustomResult> = {
    anyOf: [
        {
            type: "string"
        },
        {
            type: "object",
            required: ["sourceText", "contributingVariants"],
            properties: {
                sourceText: {
                    type: "string"
                },
                contributingVariants: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            }
        }
    ]
};

export default customResultSchema;
