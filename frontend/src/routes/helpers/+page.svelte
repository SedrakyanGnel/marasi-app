<script>
    import { getToastStore } from "@skeletonlabs/skeleton";
    import {
        customHttpqlHelpers,
        upsertHttpqlHelper,
        deleteHttpqlHelper,
        resetHttpqlHelpers,
    } from "../../stores";

    const toastStore = getToastStore();

    const emptyHelper = () => ({
        id: null,
        name: "",
        description: "",
        parameters: "",
        body: "",
    });

    const templates = [
        {
            name: "Contains Word",
            description:
                "Returns true when the supplied value contains the provided word.",
            parameters: "value, word",
            body: `
if (!value || !word) return false;
const haystack = String(value).toLowerCase();
const needle = String(word).toLowerCase();
return haystack.includes(needle);`.trim(),
        },
        {
            name: "LooksLikeJWT",
            description:
                "Detects JWT-style tokens within the provided string.",
            parameters: "payload",
            body: `
if (!payload) return false;
const tokenPattern = /([A-Za-z0-9-_]{20,})\\.([A-Za-z0-9-_]{20,})\\.([A-Za-z0-9-_]{20,})/;
return tokenPattern.test(String(payload));
`.trim(),
        },
        {
            name: "headerEq",
            description: "Compares a header value ignoring casing.",
            parameters: "headers, name, expected",
            body: `
if (!headers || !name) return false;
const key = Object.keys(headers).find(
    (entry) => entry.toLowerCase() === String(name).toLowerCase(),
);
if (!key) return false;
return String(headers[key]).toLowerCase() === String(expected ?? "").toLowerCase();
`.trim(),
        },
        {
            name: "ResponseBracketFinder",
            description:
                "Returns the position of each '[' detected in the response body.",
            parameters: "request, response",
            body: `
const text = (response?.Body ?? response?.body ?? response ?? "").toString();
const matches = [];
for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") {
        matches.push({ start: i, end: i + 1 });
    }
}
return { matched: matches.length > 0, responseMatches: matches };
`.trim(),
        },
    ];

    let helperForm = emptyHelper();
    let codeError = "";
    let nameError = "";

    $: codeError = helperForm.body ? validateHelper(helperForm) : "";
    $: nameError = helperForm.name?.trim().length ? "" : "Name is required";

    function validateHelper(helper) {
        const params = helper.parameters
            ? helper.parameters
                  .split(",")
                  .map((param) => param.trim())
                  .filter((param) => param.length > 0)
            : [];
        const body = helper.body?.trim() || "return false;";
        try {
            // eslint-disable-next-line no-new-func
            new Function(...params, body);
            return "";
        } catch (error) {
            return error.message;
        }
    }

    function editHelper(helper) {
        helperForm = { ...helper };
    }

    function applyTemplate(template) {
        helperForm = {
            ...helperForm,
            name: template.name,
            description: template.description,
            parameters: template.parameters,
            body: template.body,
            id: null,
        };
    }

    function resetForm() {
        helperForm = emptyHelper();
    }

    function saveHelper() {
        if (nameError || codeError) {
            return;
        }
        const saved = upsertHttpqlHelper(helperForm);
        toastStore.trigger({
            message: `${saved.name} saved`,
            background: "variant-filled-success",
        });
        helperForm = emptyHelper();
    }

    function removeHelper(id) {
        deleteHttpqlHelper(id);
        if (helperForm.id === id) {
            helperForm = emptyHelper();
        }
        toastStore.trigger({
            message: "Helper deleted",
            background: "variant-filled-error",
        });
    }

    function clearAllHelpers() {
        resetHttpqlHelpers();
        helperForm = emptyHelper();
        toastStore.trigger({
            message: "Cleared all custom helpers",
            background: "variant-filled-warning",
        });
    }
</script>

<svelte:head>
    <title>HTTPQL Helpers</title>
</svelte:head>

<section class="helpers-page">
    <header class="page-header">
        <div>
            <h1>HTTPQL Helpers</h1>
            <p>
                Extend HTTPQL with your own helper functions. Helpers become
                available instantly inside the Requests tab.
            </p>
        </div>
        <button class="ghost" on:click={clearAllHelpers}>
            Clear all
        </button>
    </header>

    <div class="layout">
        <aside class="library">
            <h2>Saved Helpers ({$customHttpqlHelpers.length})</h2>
            {#if $customHttpqlHelpers.length === 0}
                <p class="hint">
                    Nothing yet. Use the builder on the right or start from a
                    template.
                </p>
            {:else}
                <ul>
                    {#each $customHttpqlHelpers as helper}
                        <li class={helper.id === helperForm.id ? "active" : ""}>
                            <button on:click={() => editHelper(helper)}>
                                <span>
                                    <strong>{helper.name}</strong>
                                    <small>{helper.description}</small>
                                </span>
                                <span class="actions">
                                    <button
                                        type="button"
                                        class="ghost danger"
                                        on:click={(event) => {
                                            event.stopPropagation();
                                            removeHelper(helper.id);
                                        }}
                                    >
                                        Delete
                                    </button>
                                </span>
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
            <div class="templates">
                <h3>Templates</h3>
                {#each templates as template}
                    <button
                        type="button"
                        class="template"
                        on:click={() => applyTemplate(template)}
                    >
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                    </button>
                {/each}
            </div>
        </aside>
        <form class="builder" on:submit|preventDefault={saveHelper}>
            <h2>{helperForm.id ? "Edit Helper" : "New Helper"}</h2>
            <label>
                Name
                <input
                    type="text"
                    bind:value={helperForm.name}
                    placeholder="e.g. containsWord"
                />
            </label>
            {#if nameError}
                <p class="error">{nameError}</p>
            {/if}
            <label>
                Description
                <textarea
                    rows="2"
                    bind:value={helperForm.description}
                    placeholder="What does this helper check?"
                ></textarea>
            </label>
            <label>
                Parameters (comma separated)
                <input
                    type="text"
                    bind:value={helperForm.parameters}
                    placeholder="e.g. value, keyword"
                />
            </label>
            <label>
                Function Body
                <textarea
                    rows="8"
                    bind:value={helperForm.body}
                    placeholder="return Boolean(value);"
                ></textarea>
            </label>
            <p class="hint">
                Helpers are standard JavaScript functions. Use the parameters
                defined above (for example
                <code>value</code>) and return either a boolean or an object
                like
                <code
                    >&lcub; matched: true, requestMatches: [&#123; start: 10,
                    end: 20 &#125;] &rcub;</code
                >
                to highlight matches inside the drawer search. Helper
                expressions entered in the drawer behave exactly like they do in
                HTTPQL, so you can reference <code>request.*</code>,
                <code>response.*</code>, and <code>metadata.*</code> fields.
            </p>
            {#if codeError}
                <p class="error">Compilation error: {codeError}</p>
            {/if}
            <div class="builder-actions">
                <button type="submit" class="primary" disabled={nameError || codeError}>
                    Save helper
                </button>
                <button type="button" class="ghost" on:click={resetForm}>
                    Clear form
                </button>
            </div>
        </form>
    </div>
</section>

<style>
    .helpers-page {
        padding: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .page-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
    }

    .layout {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) 2fr;
        gap: 1.5rem;
    }

    .library {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 1rem;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .library ul {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .library li button {
        width: 100%;
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 0.75rem;
        padding: 0.6rem;
        background: rgba(255, 255, 255, 0.02);
        cursor: pointer;
        text-align: left;
    }

    .library li.active button {
        border-color: #60a5fa;
        box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.3);
    }

    .templates {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .templates .template {
        text-align: left;
        border-radius: 0.75rem;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.02);
        padding: 0.6rem;
        cursor: pointer;
    }

    .builder {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 1rem;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        background: rgba(0, 0, 0, 0.2);
    }

    .builder label {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }

    .builder input,
    .builder textarea {
        border-radius: 0.75rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
        padding: 0.5rem;
        background: rgba(255, 255, 255, 0.02);
        color: inherit;
        font-family: inherit;
    }

    .builder-actions {
        display: flex;
        gap: 0.6rem;
    }

    .primary {
        background: #2563eb;
        border: none;
        border-radius: 0.75rem;
        padding: 0.5rem 1rem;
        color: white;
        cursor: pointer;
    }

    .ghost {
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: transparent;
        border-radius: 0.75rem;
        padding: 0.4rem 0.8rem;
        cursor: pointer;
    }

    .ghost.danger {
        border-color: rgba(248, 113, 113, 0.5);
        color: #f87171;
    }

    .hint {
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.6);
    }

    .error {
        font-size: 0.85rem;
        color: #f87171;
    }

    @media (max-width: 900px) {
        .layout {
            grid-template-columns: 1fr;
        }
    }
</style>
