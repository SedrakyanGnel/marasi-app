export function compileHelperDefinitions(definitions = []) {
    const helpers = {};
    const errors = [];
    definitions.forEach((helper) => {
        const name = helper?.name?.trim();
        if (!name) return;
        const params = helper?.parameters
            ? helper.parameters
                  .split(",")
                  .map((param) => param.trim())
                  .filter((param) => param.length > 0)
            : [];
        const body = helper?.body?.trim() || "return false;";
        try {
            // eslint-disable-next-line no-new-func
            helpers[name] = new Function(...params, body);
        } catch (error) {
            errors.push({
                id: helper.id,
                name,
                message: error.message,
            });
        }
    });
    return { helpers, errors };
}

export function getHelperCompletionEntries(definitions = []) {
    return Array.from(
        new Set(
            definitions.flatMap((helper) => {
                const name = helper?.name?.trim();
                if (!name) return [];
                return name.endsWith("(") ? [name] : [name, `${name}(`];
            }),
        ),
    );
}
