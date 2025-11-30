<script>
    import { onMount } from "svelte";
    import CodeMirror from "svelte-codemirror-editor";
    import { GetNote, GetRawDetails } from "../wailsjs/go/main/App";
    import {
        Braces,
        CodeIcon,
        CopyIcon,
        Maximize,
        Pen,
        WrapTextIcon,
    } from "lucide-svelte";
    import {
        drawerHeight,
        marasiConfig,
        prettify,
        lineWrap,
        customHttpqlHelpers,
    } from "../../stores";
    import {
        getModalStore,
        getDrawerStore,
        getToastStore,
    } from "@skeletonlabs/skeleton";
    import { vim } from "@replit/codemirror-vim";
    import { StreamLanguage } from "@codemirror/language";
    import { http } from "@codemirror/legacy-modes/mode/http";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { beforeNavigate, goto } from "$app/navigation";
    import { compileHelperDefinitions } from "../utils/helpers";
    import { compileHttpql } from "../utils/httpql";
    import { EditorView, Decoration } from "@codemirror/view";
    import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";

    const modalStore = getModalStore();
    const drawerStore = getDrawerStore();
    export let request_id;
    export let titleText = "";
    export let showTitleBar = true;
    export let showSizeToggle = false;
    export let showPrettifyToggle = true;
    export let requestReadOnly = true;
    export let responseReadOnly = true;
    // Request body is exported for launchpad
    export let requestBody;

    let responseBody, selectedRow;
    let requestEditorView;
    let responseEditorView;
    let searchMode = "text";
    let searchQuery = "";
    let caseSensitiveSearch = false;
    let helperQuery = "";
    let helperMatchesSummary = [];
    let helperSearchError = "";
    let helperFunctionMap = {};
    let helperCompilationErrors = [];
    let requestHighlights = [];
    let responseHighlights = [];
    let textMatchCount = 0;

    let userEdited = false;
    const highlightMark = Decoration.mark({
        class: "cm-search-highlight",
    });
    const setHighlightsEffect = StateEffect.define();
    const highlightField = StateField.define({
        create() {
            return Decoration.none;
        },
        update(highlights, tr) {
            if (tr.docChanged) {
                highlights = highlights.map(tr.changes);
            }
            for (const effect of tr.effects) {
                if (effect.is(setHighlightsEffect)) {
                    highlights = effect.value;
                }
            }
            return highlights;
        },
        provide: (field) => EditorView.decorations.from(field),
    });
    function adjustHeights() {
        const editors = document.querySelectorAll(".cm-editor");

        // First, reset heights to auto to get true content height
        editors.forEach((editor) => {
            editor.style.height = "auto";
        });

        // Force layout recalculation
        void editors[0]?.offsetHeight;

        let maxHeight = 0;

        // Now find the maximum content height
        editors.forEach((editor) => {
            // Use scrollHeight to get full content height
            const height = editor.scrollHeight;
            if (height > maxHeight) {
                maxHeight = height;
            }
        });

        // Set minimum height (can adjust as needed)
        maxHeight = Math.max(maxHeight, 200);

        // Now set all editors to the maximum height
        editors.forEach((editor) => {
            editor.style.height = `${maxHeight}px`;
        });
    }

    function createDecorations(doc, ranges) {
        if (!ranges?.length) return Decoration.none;
        const builder = new RangeSetBuilder();
        ranges.forEach((range) => {
            const from = Math.max(0, Math.min(doc.length, range.from));
            const to = Math.max(0, Math.min(doc.length, range.to));
            if (to > from) {
                builder.add(from, to, highlightMark);
            }
        });
        return builder.finish();
    }

    function updateRequestEditorHighlights(ranges) {
        if (!requestEditorView) return;
        requestEditorView.dispatch({
            effects: setHighlightsEffect.of(
                createDecorations(requestEditorView.state.doc, ranges),
            ),
        });
    }

    function updateResponseEditorHighlights(ranges) {
        if (!responseEditorView) return;
        responseEditorView.dispatch({
            effects: setHighlightsEffect.of(
                createDecorations(responseEditorView.state.doc, ranges),
            ),
        });
    }

    function clearHighlights() {
        requestHighlights = [];
        responseHighlights = [];
        textMatchCount = 0;
        updateRequestEditorHighlights(requestHighlights);
        updateResponseEditorHighlights(responseHighlights);
    }

    function findAllOccurrences(text, needle, caseSensitive) {
        if (!text || !needle) return [];
        const source = caseSensitive ? text : text.toLowerCase();
        const query = caseSensitive ? needle : needle.toLowerCase();
        const ranges = [];
        if (!query.length) return ranges;
        let index = 0;
        while ((index = source.indexOf(query, index)) !== -1) {
            ranges.push({ from: index, to: index + query.length });
            index += query.length || 1;
        }
        return ranges;
    }

    function runTextSearch(
        query,
        isCaseSensitive,
        requestText,
        responseText,
    ) {
        if (!query?.length) {
            clearHighlights();
            return;
        }
        requestHighlights = findAllOccurrences(
            requestText ?? "",
            query,
            isCaseSensitive,
        );
        responseHighlights = findAllOccurrences(
            responseText ?? "",
            query,
            isCaseSensitive,
        );
        textMatchCount = requestHighlights.length + responseHighlights.length;
    }

    function normalizeMatchRange(range) {
        if (!range) return null;
        if (Array.isArray(range) && range.length >= 2) {
            const from = Number(range[0]);
            const to = Number(range[1]);
            if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
                return { from, to };
            }
            return null;
        }
        const from = Number(range.start ?? range.from);
        const to = Number(range.end ?? range.to);
        if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
            return { from, to };
        }
        return null;
    }

    function extractMatches(result, key) {
        const values =
            result?.[key] ??
            result?.[`${key}Matches`] ??
            result?.[`${key}Match`] ??
            [];
        if (!Array.isArray(values)) return [];
        return values.map(normalizeMatchRange).filter(Boolean);
    }

    function reduceHelperCaptures(captures) {
        const requestMatches = [];
        const responseMatches = [];
        const summary = [];
        captures.forEach((capture) => {
            if (!capture?.result || typeof capture.result !== "object") return;
            const req = extractMatches(capture.result, "request");
            const res = extractMatches(capture.result, "response");
            if (req.length || res.length) {
                requestMatches.push(...req);
                responseMatches.push(...res);
                summary.push({
                    name: capture.name,
                    request: req.length,
                    response: res.length,
                });
            }
        });
        return { requestMatches, responseMatches, summary };
    }

    function runHelperSearch() {
        helperSearchError = "";
        helperMatchesSummary = [];
        if (!selectedRow) {
            helperSearchError = "Request details are still loading.";
            return;
        }
        if (!helperQuery.trim()) {
            helperSearchError = "Enter a helper expression to run.";
            return;
        }
        const compiled = compileHttpql(helperQuery, helperFunctionMap);
        if (compiled.error) {
            helperSearchError = compiled.error.message;
            return;
        }
        const captures = [];
        const matched = compiled.test(selectedRow, {
            captureHelperResult: (payload) => {
                captures.push(payload);
            },
        });
        const aggregated = reduceHelperCaptures(captures);
        requestHighlights = aggregated.requestMatches;
        responseHighlights = aggregated.responseMatches;
        helperMatchesSummary = aggregated.summary;
        if (!requestHighlights.length && !responseHighlights.length) {
            helperSearchError = matched
                ? "Helper matched but did not return match ranges."
                : "Helper did not match.";
        } else {
            helperSearchError = "";
        }
    }

    function switchSearchMode(mode) {
        if (mode === searchMode) return;
        searchMode = mode;
        helperSearchError = "";
        helperMatchesSummary = [];
        if (mode === "text") {
            runTextSearch(
                searchQuery,
                caseSensitiveSearch,
                requestBody,
                responseBody,
            );
        } else {
            clearHighlights();
        }
    }

    // Get lang based on body length and config
    function getLang(body) {
        switch ($marasiConfig.SyntaxMode) {
            case "disabled":
                return undefined;
            case "auto":
                // Check length
                if (body.length < 75000) return StreamLanguage.define(http);
                return undefined;
            case "enabled":
                return StreamLanguage.define(http);
        }
    }

    function viewNote() {
        GetNote(request_id.toString()).then((note) => {
            const modal = {
                type: "component",
                component: "Notes",
                title: titleText + " notes",
                requestID: request_id,
                content: note,
            };
            if (!$modalStore[0]) {
                modalStore.trigger(modal);
            }
        });
    }

    function viewMetadata() {
        const modal = {
            type: "component",
            component: "Metadata",
            content: selectedRow?.Metadata,
            title: titleText + " Metadata",
        };
        if (!$modalStore[0]) {
            modalStore.trigger(modal);
        }
    }

    function togglePrettify() {
        // If the editors are readonly and it's safe to toggle
        if (requestReadOnly && responseReadOnly) {
            // No edits, toggle directly
            prettify.update((value) => !value);
            setTimeout(adjustHeights, 50);
        } else {
            if (userEdited) {
                const modal = {
                    type: "confirm",
                    title: "Confirm Action",
                    body: "You have made changes to the text. Switching prettify mode will discard these changes. Continue?",
                    response: (result) => {
                        if (result) {
                            // User confirmed, proceed with toggle
                            prettify.update((value) => !value);
                            userEdited = false;
                            setTimeout(adjustHeights, 50);
                        }
                    },
                };
                modalStore.trigger(modal);
            } else {
                // No edits, toggle directly
                prettify.update((value) => !value);
                setTimeout(adjustHeights, 50);
            }
        }
    }
    function safeCompare(editorText, originalText) {
        if (typeof originalText !== "string") return false;
        return editorText === originalText.replaceAll("\r\n", "\n");
    }

    $: {
        GetRawDetails(request_id).then((row) => {
            selectedRow = row;
            if ($prettify) {
                requestBody =
                    row?.Metadata?.["prettified-request"] ??
                    row?.Request?.Raw ??
                    "";
                responseBody =
                    row?.Metadata?.["prettified-response"] ??
                    row?.Response?.Raw ??
                    "";
            } else {
                requestBody = row?.Request?.Raw ?? "";
                responseBody = row?.Response?.Raw ?? "";
            }
            setTimeout(adjustHeights, 50);
        });
    }
    beforeNavigate(({ to, cancel }) => {
        if (requestReadOnly && responseReadOnly) return;
        if (userEdited) {
            // Cancel and handle the goto manually in the modal response
            cancel();
            const modal = {
                type: "confirm",
                title: "Confirm Action",
                body: "You have made changes to the text. Navigating away will clear your changes. Continue?",
                response: (result) => {
                    if (result) {
                        // Force navigation
                        userEdited = false;
                        goto(to?.route?.id);
                    } else {
                        cancel();
                    }
                },
            };
            modalStore.trigger(modal);
        } else return;
    });
    onMount(() => {
        GetRawDetails(request_id).then((row) => {
            selectedRow = row;
            if ($prettify) {
                requestBody =
                    row?.Metadata?.["prettified-request"] ??
                    row?.Request?.Raw ??
                    "";
                responseBody =
                    row?.Metadata?.["prettified-response"] ??
                    row?.Response?.Raw ??
                    "";
            } else {
                requestBody = row?.Request?.Raw ?? "";
                responseBody = row?.Response?.Raw ?? "";
            }
            setTimeout(adjustHeights, 50);
        });
    });

    $: {
        const { helpers, errors } = compileHelperDefinitions(
            $customHttpqlHelpers,
        );
        helperFunctionMap = helpers;
        helperCompilationErrors = errors;
    }

    $: if (searchMode === "text") {
        runTextSearch(
            searchQuery,
            caseSensitiveSearch,
            requestBody,
            responseBody,
        );
    }

    $: updateRequestEditorHighlights(requestHighlights);
    $: updateResponseEditorHighlights(responseHighlights);

    $: {
        // If the editors are readonly and it's safe to toggle
        if (requestReadOnly && responseReadOnly) {
            if ($prettify) {
                requestBody =
                    selectedRow?.Metadata?.["prettified-request"] ??
                    selectedRow?.Request?.Raw ??
                    "";
                responseBody =
                    selectedRow?.Metadata?.["prettified-response"] ??
                    selectedRow?.Response?.Raw ??
                    "";
            } else {
                requestBody = selectedRow?.Request?.Raw ?? "";
                responseBody = selectedRow?.Response?.Raw ?? "";
            }
        } else {
            if (!userEdited) {
                if ($prettify) {
                    requestBody =
                        selectedRow?.Metadata?.["prettified-request"] ??
                        selectedRow?.Request?.Raw ??
                        "";
                    responseBody =
                        selectedRow?.Metadata?.["prettified-response"] ??
                        selectedRow?.Response?.Raw ??
                        "";
                } else {
                    requestBody = selectedRow?.Request?.Raw ?? "";
                    responseBody = selectedRow?.Response?.Raw ?? "";
                }
            }
        }
        setTimeout(adjustHeights, 50);
    }
</script>

{#if showTitleBar}
    <div
        class="flex p-2 justify-between items-center w-full sticky top-0 z-50 bg-inherit"
    >
        <div class="flex items-center space-x-2 flex-shrink-0">
            {#if showSizeToggle}
                <button
                    class="p-1 rounded {$drawerHeight === 'h-[100%]'
                        ? 'bg-warning-500 text-slate-500'
                        : 'bg-warning-50 text-slate-500'}"
                    on:click={() => {
                        if ($drawerStore.open) {
                            if ($drawerHeight === "h-[60%]") {
                                $drawerHeight = "h-[100%]";
                                $drawerStore.height = $drawerHeight;
                            } else {
                                $drawerHeight = "h-[60%]";
                                $drawerStore.height = $drawerHeight;
                            }
                        }
                    }}
                >
                    <Maximize size={16} />
                </button>
            {/if}
            <h5 class="h5 flex-shrink-0">{titleText}</h5>
        </div>
        <div class="flex space-x-2 flex-grow justify-center">
            <button
                class="btn btn-sm variant-soft-primary flex items-center"
                on:click={() => {
                    navigator.clipboard.writeText(requestBody);
                }}
            >
                <CopyIcon size={14} class="mr-1" /> Copy Request
            </button>
            <button
                class="btn btn-sm variant-soft-primary flex items-center"
                on:click={() => {
                    navigator.clipboard.writeText(responseBody);
                }}
            >
                <CopyIcon size={14} class="mr-1" /> Copy Response
            </button>
            <button
                class="btn btn-sm variant-soft-secondary flex items-center"
                on:click={() => {
                    viewNote();
                }}
            >
                <Pen size={14} class="mr-1" /> View Note
            </button>
            <button
                class="btn btn-sm variant-soft-secondary flex items-center"
                on:click={() => {
                    viewMetadata();
                }}
            >
                <Braces size={14} class="mr-1" /> View Metadata
            </button>
        </div>
        <div class="flex justify-right space-x-2">
            {#if showPrettifyToggle}
                <div class="flex items-center space-x-2 flex-shrink-0">
                    <span class="text-sm">Prettify</span>
                    <button
                        class="p-1 rounded {$prettify
                            ? 'bg-warning-500 text-slate-500'
                            : 'bg-warning-50 text-slate-500'}"
                        on:click={() => {
                            togglePrettify();
                        }}
                    >
                        <CodeIcon size={16} />
                    </button>
                </div>
            {/if}
            <div class="flex items-center space-x-2 flex-shrink-0">
                <span class="text-sm">Linewrap</span>
                <button
                    class="p-1 rounded {$lineWrap
                        ? 'bg-warning-500 text-slate-500'
                        : 'bg-warning-50 text-slate-500'}"
                    on:click={() => {
                        $lineWrap = $lineWrap ? false : true;
                        setTimeout(adjustHeights, 50);
                    }}
                >
                    <WrapTextIcon size={16} />
                </button>
            </div>
        </div>
    </div>
{/if}

<style>
    .search-panel {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        background: rgba(0, 0, 0, 0.2);
    }
    .search-mode-toggle {
        display: inline-flex;
        gap: 0.5rem;
    }
    .search-mode-toggle button {
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: transparent;
        border-radius: 999px;
        padding: 0.2rem 0.8rem;
        font-size: 0.85rem;
        cursor: pointer;
        color: inherit;
    }
    .search-mode-toggle button.selected {
        background: rgba(96, 165, 250, 0.2);
        border-color: rgba(96, 165, 250, 0.5);
    }
    .text-search-controls,
    .helper-search-controls {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .text-search-controls input,
    .helper-search-controls textarea {
        border-radius: 0.6rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(0, 0, 0, 0.3);
        padding: 0.45rem 0.6rem;
        color: inherit;
        font-family: inherit;
    }
    .case-toggle {
        font-size: 0.85rem;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
    }
    .helper-actions {
        display: flex;
        justify-content: flex-start;
    }
    .helper-match-summary {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: 0.85rem;
        color: rgba(255, 255, 255, 0.7);
    }
    .helper-match-summary li {
        padding: 0.2rem 0;
    }
    :global(.cm-search-highlight) {
        background-color: rgba(250, 204, 21, 0.35);
    }
</style>

<div class="search-panel">
    <div class="search-mode-toggle">
        <button
            class:selected={searchMode === "text"}
            type="button"
            on:click={() => switchSearchMode("text")}
        >
            Text Search
        </button>
        <button
            class:selected={searchMode === "helper"}
            type="button"
            on:click={() => switchSearchMode("helper")}
        >
            Helper Search
        </button>
    </div>
    {#if searchMode === "text"}
        <div class="text-search-controls">
            <input
                type="text"
                placeholder="Search within request or response"
                bind:value={searchQuery}
            />
            <label class="case-toggle">
                <input
                    type="checkbox"
                    bind:checked={caseSensitiveSearch}
                />
                Case sensitive
            </label>
            <span class="hint">{textMatchCount} matches</span>
        </div>
    {:else}
        <div class="helper-search-controls">
            <textarea
                rows="2"
                bind:value={helperQuery}
                placeholder='Helper expression, e.g. customFinder(request.body, "token")'
            ></textarea>
            <div class="helper-actions">
                <button
                    type="button"
                    class="btn btn-sm variant-filled-primary"
                    on:click={runHelperSearch}
                >
                    Highlight helper matches
                </button>
            </div>
            {#if helperCompilationErrors.length}
                <p class="error-label">
                    Helper "{helperCompilationErrors[0].name}" failed to load:
                    {helperCompilationErrors[0].message}
                </p>
            {/if}
            {#if helperSearchError}
                <p class="error-label">{helperSearchError}</p>
            {/if}
            {#if helperMatchesSummary.length}
                <ul class="helper-match-summary">
                    {#each helperMatchesSummary as summary}
                        <li>
                            <strong>{summary.name}</strong> — {summary.request}
                            in request, {summary.response} in response
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    {/if}
</div>

{#if requestBody || responseBody}
    <div class="flex flex-col sm:flex-row w-full">
        <div class="flex-1 p-1 overflow-auto">
            <CodeMirror
                on:ready={(event) => {
                    requestEditorView = event.detail;
                    updateRequestEditorHighlights(requestHighlights);
                }}
                on:change={(event) => {
                    const text = event.detail;
                    if (
                        !safeCompare(
                            text,
                            selectedRow?.Metadata["prettified-request"],
                        ) &&
                        !safeCompare(text, selectedRow?.Request?.Raw ?? "")
                    ) {
                        userEdited = true;
                    } else {
                        userEdited = false;
                    }
                }}
                class="text-xs"
                bind:value={requestBody}
                lang={getLang(requestBody)}
                theme={oneDark}
                extensions={[
                    highlightField,
                    ...($marasiConfig.VimEnabled ? [vim()] : []),
                ]}
                readonly={requestReadOnly}
                lineWrapping={$lineWrap}
            ></CodeMirror>
        </div>
        <div class="flex-1 p-1 overflow-auto">
            <CodeMirror
                on:ready={(event) => {
                    responseEditorView = event.detail;
                    updateResponseEditorHighlights(responseHighlights);
                }}
                class="text-xs"
                bind:value={responseBody}
                lang={getLang(responseBody)}
                theme={oneDark}
                extensions={[
                    highlightField,
                    ...($marasiConfig.VimEnabled ? [vim()] : []),
                ]}
                readonly={responseReadOnly}
                lineWrapping={$lineWrap}
            ></CodeMirror>
        </div>
    </div>
{/if}
