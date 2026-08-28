(function () {
    'use strict';

    // ---- PLUGIN ADAPTER: config source, retrofit for VideoOSD Tweaks and Candy ----
    // Unlike the other 7 mods, this one has almost nothing left to adapt:
    // the actual enable/disable-per-mod decision (which used to be a
    // concern here) is now handled entirely at the C# plugin level
    // (Plugin.cs conditionally includes/excludes each mod's own <script>
    // tag based on its EnableXxx setting), so this script's own
    // registerAddon()/isAddonEnabled()/setAddonEnabled() logic below is
    // completely untouched -- it still just reads/writes localStorage
    // exactly as before, for whichever mods actually got loaded. The only
    // genuinely new capability here is the popup list's own sort order.
    const PLUGIN_GUID = '468b1980-7a6c-4e45-a129-24825085ece4';

    // ============================================================
    // == SHARED VALUE (both standalone and plugin usage) ==
    // 'alphabetical' reproduces the exact original (and only) sort
    // behavior. 'custom' is the new capability, using customOrder below.
    // Both fields are plain local values, editable by hand for a
    // standalone user exactly like the plugin can set them.
    // ============================================================
    let sortMode = 'alphabetical';
    let customOrder = [];

    async function fetchPluginConfig() {
        const maxAttempts = 120;
        const delayMs = 250;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (window.ApiClient && typeof ApiClient.getPluginConfiguration === 'function') {
                try {
                    const config = await ApiClient.getPluginConfiguration(PLUGIN_GUID);
                    if (config) return config;
                } catch (err) {
                    // fall through, try again after the delay below
                }
            }
            await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
        }
        return null;
    }

    function applyPluginConfig(pluginConfig) {
        if (!pluginConfig) return;

        if (typeof pluginConfig.CustomsMenuSortMode === 'string') {
            sortMode = pluginConfig.CustomsMenuSortMode;
        }
        if (typeof pluginConfig.CustomsMenuCustomOrder === 'string' && pluginConfig.CustomsMenuCustomOrder) {
            customOrder = pluginConfig.CustomsMenuCustomOrder
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
        }
    }
    // ---- END PLUGIN ADAPTER ----


    const CUSTOMS_ID = 'jvosd-customs';
    const ITEM_HEIGHT_REM = 2.7;
    const DONE = new WeakSet();

    const API_NAME = 'JellyfinVideoOSDCustomsMenu';
    const STORAGE_PREFIX = 'JellyfinVideoOSDCustomsMenu.addon.';

    const VANILLA_ACTIONSHEET_ENTRY_MS = 140;
    const VANILLA_ACTIONSHEET_EXIT_MS = 100;
    const VANILLA_BACKDROP_REMOVE_MS = 300;

    const addons = new Map();

    let pendingCustomsContext = null;
    let closingEverything = false;

    function getItemHeight() {
        const rootFontSize =
            parseFloat(getComputedStyle(document.documentElement).fontSize) ||
            16;

        return ITEM_HEIGHT_REM * rootFontSize;
    }

    function fitSheetToViewport(sheet, originalTop, originalCount, newCount) {
        const diff = newCount - originalCount;
        const itemHeight = getItemHeight();
        const targetTop = originalTop - (diff * itemHeight);

        sheet.style.top = `${targetTop}px`;
    }

    function fitPopupLikeVanilla(popup, originalRect, originalCount, newCount) {
        const diff = originalCount - newCount;
        const itemHeight = getItemHeight();
        const targetTop = originalRect.top + (diff * itemHeight);

        popup.style.top = `${targetTop}px`;
    }

    function ensureStyles() {
        if (document.getElementById('jvosd-customs-style')) return;

        const style = document.createElement('style');
        style.id = 'jvosd-customs-style';

        style.textContent = `
            .jvosd-customs-backdrop {
                position: fixed;
                inset: 0;
                z-index: 999998;
                background-color: #000;
                opacity: 0;
                transition: opacity ease-out 0.2s;
                pointer-events: auto;
                will-change: opacity;
            }

            .jvosd-customs-backdrop.is-active {
                opacity: 0.5;
            }

            /*
             * Das Popup bekommt zusätzlich Jellyfin/Vanilla-Klassen:
             * focuscontainer dialog actionsheet-not-fullscreen actionSheet
             *
             * Deshalb hier KEIN hartes background/color setzen.
             * Jellyfins Theme soll den ActionSheet-Look liefern.
             */
            .jvosd-customs-popup {
                position: fixed;
                z-index: 999999;
                width: max-content;
                min-width: max-content;
                max-width: calc(100vw - 20px);
                border-radius: 0.1em !important;
                box-shadow:
                    0 16px 24px 2px rgba(0, 0, 0, 0.14),
                    0 6px 30px 5px rgba(0, 0, 0, 0.12),
                    0 8px 10px -5px rgba(0, 0, 0, 0.4);
                overflow: hidden;
                animation: scaleup ${VANILLA_ACTIONSHEET_ENTRY_MS}ms ease-out normal both;
                will-change: transform, opacity;
                outline: none;
            }

            .jvosd-customs-popup.is-closing {
                animation: scaledown ${VANILLA_ACTIONSHEET_EXIT_MS}ms ease-out normal both;
            }

            .jvosd-customs-popup .actionSheetContent,
            .jvosd-customs-popup .actionSheetScroller {
                width: 100% !important;
                min-width: 100% !important;
            }

            .jvosd-customs-popup .jvosd-customs-addon-item {
                display: flex !important;
                align-items: center;
                width: 100% !important;
                min-width: 100% !important;
                max-width: 100% !important;
                white-space: nowrap;
                box-sizing: border-box;
            }

            /*
             * Checked-State und Hover-State sind hier bewusst getrennt:
             * Aktivierte Addons bekommen keinen eigenen Hintergrund.
             * Der Hintergrund gehört ausschließlich dem echten Maus-Hover.
             */
            .jvosd-customs-popup .jvosd-customs-addon-item,
            .jvosd-customs-popup .jvosd-customs-addon-item:focus,
            .jvosd-customs-popup .jvosd-customs-addon-item:focus-visible,
            .jvosd-customs-popup .jvosd-customs-addon-item:active,
            .jvosd-customs-popup .jvosd-customs-addon-item[aria-selected="true"],
            .jvosd-customs-popup .jvosd-customs-addon-item[aria-checked="true"],
            .jvosd-customs-popup .jvosd-customs-addon-item.checked,
            .jvosd-customs-popup .jvosd-customs-addon-item.selected,
            .jvosd-customs-popup .jvosd-customs-addon-item.emby-button-focus,
            .jvosd-customs-popup .jvosd-customs-addon-item.emby-button-focused,
            .jvosd-customs-popup .jvosd-customs-addon-item.focused,
            .jvosd-customs-popup .jvosd-customs-addon-item.listItem-focussed,
            .jvosd-customs-popup .jvosd-customs-addon-item.listItem-focused,
            .jvosd-customs-popup .jvosd-customs-addon-item.paper-icon-button-light:focus {
                background: transparent !important;
                background-color: transparent !important;
                box-shadow: none !important;
                outline: none !important;
            }

            .jvosd-customs-popup .jvosd-customs-addon-item:hover {
                background: rgba(255,255,255,.14) !important;
                background-color: rgba(255,255,255,.14) !important;
            }

            .jvosd-customs-popup .jvosd-customs-addon-item:hover:focus,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover:focus-visible,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover:active,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover[aria-selected="true"],
            .jvosd-customs-popup .jvosd-customs-addon-item:hover[aria-checked="true"],
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.checked,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.selected,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.emby-button-focus,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.emby-button-focused,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.focused,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.listItem-focussed,
            .jvosd-customs-popup .jvosd-customs-addon-item:hover.listItem-focused {
                background: rgba(255,255,255,.14) !important;
                background-color: rgba(255,255,255,.14) !important;
            }

            .jvosd-customs-popup .jvosd-customs-check {
                font-family: "Material Icons", "Material Symbols Outlined";
                font-size: 143%;
                width: 2.3em;
                min-width: 2.3em;
                max-width: 2.3em;
                text-align: center;
                flex: 0 0 2.3em;
                transform: translateX(-0.18em);
            }

            .jvosd-customs-popup .jvosd-customs-check.is-off {
                visibility: hidden;
            }

            .jvosd-customs-popup .listItemBody {
                width: auto !important;
                min-width: 0 !important;
                flex: 0 0 auto !important;
            }

            .jvosd-customs-popup .actionSheetItemText {
                width: max-content !important;
                max-width: none !important;
                white-space: nowrap;
            }
        `;

        document.head.appendChild(style);
    }

    function removeVisualButtonState(button) {
        if (!button) return;

        button.blur();

        button.removeAttribute('aria-selected');
        button.removeAttribute('selected');

        button.classList.remove(
            'checked',
            'selected',
            'focused',
            'emby-button-focus',
            'emby-button-focused',
            'listItem-focussed',
            'listItem-focused',
            'paper-icon-button-light'
        );
    }

    function moveFocusToPopup(button) {
        const popup = button?.closest?.('.jvosd-customs-popup');

        if (!popup) return;

        requestAnimationFrame(() => {
            if (!popup.isConnected) return;

            removeVisualButtonState(button);

            try {
                popup.focus({
                    preventScroll: true
                });
            } catch {
                popup.focus();
            }
        });
    }

    function sizePopupRowsToFullWidth(popup) {
        if (!popup) return;

        const items = Array.from(
            popup.querySelectorAll('.jvosd-customs-addon-item')
        );

        if (!items.length) return;

        const viewportLimit = Math.max(0, window.innerWidth - 20);

        popup.style.width = '';
        popup.style.minWidth = '';

        const widestItem = Math.max(
            ...items.map(item => Math.ceil(item.scrollWidth))
        );

        if (!widestItem) return;

        const targetWidth = Math.min(widestItem, viewportLimit);

        popup.style.width = `${targetWidth}px`;
        popup.style.minWidth = `${targetWidth}px`;
    }

    function closeCustomsPopup(options = {}) {
        const keepBackdrop = !!options.keepBackdrop;
        const animate = !!options.animate;

        const popups = Array.from(
            document.querySelectorAll('.jvosd-customs-popup')
        );

        if (animate && popups.length) {
            popups.forEach(el => {
                el.classList.add('is-closing');
                setTimeout(() => el.remove(), VANILLA_ACTIONSHEET_EXIT_MS);
            });
        } else {
            popups.forEach(el => el.remove());
        }

        if (!keepBackdrop) {
            const backdrops = Array.from(
                document.querySelectorAll('.jvosd-customs-backdrop')
            );

            if (animate && backdrops.length) {
                backdrops.forEach(el => {
                    el.classList.remove('is-active');
                    setTimeout(() => el.remove(), VANILLA_BACKDROP_REMOVE_MS);
                });
            } else {
                backdrops.forEach(el => el.remove());
            }
        }
    }

    function getVisibleVanillaActionSheet() {
        return Array
            .from(document.querySelectorAll('.focuscontainer.actionSheet, .actionSheet'))
            .filter(el =>
                el.isConnected &&
                getComputedStyle(el).display !== 'none' &&
                getComputedStyle(el).visibility !== 'hidden' &&
                !el.classList.contains('hide') &&
                !el.classList.contains('jvosd-customs-popup')
            )
            .pop();
    }

    function closeVanillaActionSheetLikeJellyfin() {
        const sheet = getVisibleVanillaActionSheet();

        if (!sheet) {
            return Promise.resolve();
        }

        if (sheet.dataset.jvosdClosing === 'true') {
            return new Promise(resolve => {
                setTimeout(resolve, VANILLA_ACTIONSHEET_EXIT_MS);
            });
        }

        sheet.dataset.jvosdClosing = 'true';

        sheet.dispatchEvent(new CustomEvent('closing', {
            bubbles: false,
            cancelable: false
        }));

        sheet.style.animation =
            `scaledown ${VANILLA_ACTIONSHEET_EXIT_MS}ms ease-out normal both`;

        return new Promise(resolve => {
            let finished = false;

            const finish = () => {
                if (finished) return;
                finished = true;

                sheet.removeEventListener('animationend', finish);

                sheet.classList.add('hide');

                sheet.dispatchEvent(new CustomEvent('_close', {
                    bubbles: false,
                    cancelable: false
                }));

                resolve();
            };

            sheet.addEventListener('animationend', finish, {
                once: true
            });

            setTimeout(finish, VANILLA_ACTIONSHEET_EXIT_MS + 30);
        });
    }

    function closeCustomsPopupAndVanillaActionSheet() {
        if (closingEverything) return;

        closingEverything = true;

        closeCustomsPopup({
            animate: true
        });

        closeVanillaActionSheetLikeJellyfin().finally(() => {
            setTimeout(() => {
                closingEverything = false;
            }, 0);
        });
    }

    function ensureCustomsBackdrop() {
        ensureStyles();

        let backdrop = document.querySelector('.jvosd-customs-backdrop');

        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.className = 'jvosd-customs-backdrop';

            backdrop.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeCustomsPopupAndVanillaActionSheet();
            }, true);

            backdrop.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeCustomsPopupAndVanillaActionSheet();
            }, true);

            backdrop.addEventListener('touchstart', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeCustomsPopupAndVanillaActionSheet();
            }, true);

            backdrop.addEventListener('click', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeCustomsPopupAndVanillaActionSheet();
            }, true);

            document.body.appendChild(backdrop);
        }

        backdrop.classList.remove('is-active');

        return backdrop;
    }

    function activateCustomsBackdropLikeVanilla(backdrop) {
        void backdrop.offsetWidth;

        requestAnimationFrame(() => {
            if (backdrop.isConnected) {
                backdrop.classList.add('is-active');
            }
        });
    }

    function getEntryContext(entry) {
        const dialog = entry.closest('.actionSheet');

        const rect = dialog
            ? dialog.getBoundingClientRect()
            : entry.getBoundingClientRect();

        const scroller = dialog?.querySelector('.actionSheetScroller');

        const originalCount = scroller
            ? scroller.querySelectorAll('.actionSheetMenuItem').length
            : 6;

        return {
            rect,
            originalCount
        };
    }

    function prepareCustomsTransition(entry) {
        pendingCustomsContext = getEntryContext(entry);
        return pendingCustomsContext;
    }

    function isAddonEnabled(id) {
        return localStorage.getItem(STORAGE_PREFIX + id) === 'true';
    }

    function setAddonEnabled(id, enabled) {
        localStorage.setItem(STORAGE_PREFIX + id, enabled ? 'true' : 'false');

        const addon = addons.get(id);
        if (!addon) return;

        if (enabled) {
            addon.enable();
        } else {
            addon.disable();
        }
    }

    function ensureApi() {
        if (window[API_NAME]?.registerAddon) return;

        window[API_NAME] = {
            registerAddon(addon) {
                if (
                    !addon ||
                    !addon.id ||
                    !addon.name ||
                    typeof addon.enable !== 'function' ||
                    typeof addon.disable !== 'function'
                ) {
                    return;
                }

                addons.set(addon.id, addon);

                if (isAddonEnabled(addon.id)) {
                    addon.enable();
                } else {
                    addon.disable();
                }
            },

            isEnabled(id) {
                return isAddonEnabled(id);
            },

            setEnabled(id, enabled) {
                setAddonEnabled(id, enabled);
            },

            getAddons() {
                const all = Array.from(addons.values());

                // CHANGED: was always alphabetical before this retrofit.
                // Now supports an admin-defined custom order too (see
                // PLUGIN ADAPTER above). Any addon not present in
                // customOrder falls back to alphabetical position among
                // the other unlisted ones, so a newly added mod the admin
                // hasn't manually placed yet still shows up sensibly
                // instead of silently vanishing from the list.
                if (sortMode === 'custom' && customOrder.length) {
                    const orderIndex = new Map(customOrder.map((id, idx) => [id, idx]));

                    return all.sort((a, b) => {
                        const hasA = orderIndex.has(a.id);
                        const hasB = orderIndex.has(b.id);

                        if (hasA && hasB) return orderIndex.get(a.id) - orderIndex.get(b.id);
                        if (hasA) return -1;
                        if (hasB) return 1;

                        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                    });
                }

                return all.sort((a, b) =>
                    a.name.localeCompare(
                        b.name,
                        undefined,
                        {
                            sensitivity: 'base'
                        }
                    )
                );
            }
        };
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function escapeCssValue(value) {
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"');
    }

    function createAddonButtonHtml(addon) {
        const checked = isAddonEnabled(addon.id);

        return `
            <button
                is="emby-button"
                type="button"
                class="listItem listItem-button actionSheetMenuItem emby-button jvosd-customs-addon-item"
                data-id="${escapeHtml(addon.id)}"
                aria-checked="${checked ? 'true' : 'false'}">

                <span class="jvosd-customs-check ${checked ? '' : 'is-off'}">
                    check
                </span>

                <div class="listItemBody actionsheetListItemBody">
                    <div class="listItemBodyText actionSheetItemText">
                        ${escapeHtml(addon.name)}
                    </div>
                </div>

            </button>
        `;
    }

    function openCustomsMenu(originalRect, originalCount) {
        ensureApi();
        ensureStyles();

        closeCustomsPopup({
            keepBackdrop: true
        });

        const backdrop = ensureCustomsBackdrop();

        const registeredAddons = window[API_NAME].getAddons();
        const newCount = Math.max(registeredAddons.length, 1);

        const popup = document.createElement('div');

        /*
         * Wichtiger Fix:
         * Diese Klassen holen das Custom-Submenu näher an Jellyfins eigenes
         * ActionSheet/Dialog-Styling heran.
         */
        popup.className =
            'focuscontainer dialog actionsheet-not-fullscreen actionSheet jvosd-customs-popup';

        popup.tabIndex = -1;
        popup.style.left = `${originalRect.left}px`;

        const itemsHtml = registeredAddons.length
            ? registeredAddons.map(createAddonButtonHtml).join('')
            : `
                <button
                    is="emby-button"
                    type="button"
                    class="listItem listItem-button actionSheetMenuItem emby-button jvosd-customs-addon-item"
                    data-id="empty"
                    aria-checked="false">

                    <span class="jvosd-customs-check is-off">
                        check
                    </span>

                    <div class="listItemBody actionsheetListItemBody">
                        <div class="listItemBodyText actionSheetItemText">
                            No Customs installed
                        </div>
                    </div>

                </button>
            `;

        popup.innerHTML = `
            <div class="actionSheetContent">
                <div class="actionSheetScroller scrollY">
                    ${itemsHtml}
                </div>
            </div>
        `;

        document.body.appendChild(popup);

        sizePopupRowsToFullWidth(popup);

        fitPopupLikeVanilla(
            popup,
            originalRect,
            originalCount,
            newCount
        );

        activateCustomsBackdropLikeVanilla(backdrop);

        registeredAddons.forEach(addon => {
            const selector = `button[data-id="${escapeCssValue(addon.id)}"]`;
            const button = popup.querySelector(selector);

            if (!button) return;

            button.addEventListener('pointerup', () => {
                moveFocusToPopup(button);
            }, true);

            button.addEventListener('mouseup', () => {
                moveFocusToPopup(button);
            }, true);

            button.addEventListener('touchend', () => {
                moveFocusToPopup(button);
            }, true);

            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopImmediatePropagation();

                const nextState = !isAddonEnabled(addon.id);

                setAddonEnabled(addon.id, nextState);

                button.setAttribute(
                    'aria-checked',
                    nextState ? 'true' : 'false'
                );

                const check = button.querySelector('.jvosd-customs-check');
                if (check) {
                    check.classList.toggle('is-off', !nextState);
                }

                moveFocusToPopup(button);
            });
        });

        setTimeout(() => {
            const outside = event => {
                if (!popup.contains(event.target)) {
                    event.preventDefault();
                    event.stopImmediatePropagation();

                    closeCustomsPopupAndVanillaActionSheet();

                    document.removeEventListener('pointerdown', outside, true);
                    document.removeEventListener('mousedown', outside, true);
                    document.removeEventListener('touchstart', outside, true);
                    document.removeEventListener('click', outside, true);
                }
            };

            document.addEventListener('pointerdown', outside, true);
            document.addEventListener('mousedown', outside, true);
            document.addEventListener('touchstart', outside, true);
            document.addEventListener('click', outside, true);
        }, 0);
    }

    function createCustomsEntry() {
        const entry = document.createElement('button');

        entry.type = 'button';

        entry.setAttribute(
            'is',
            'emby-button'
        );

        entry.className =
            'listItem listItem-button actionSheetMenuItem emby-button jvosd-customs-root-entry';

        entry.dataset.id = CUSTOMS_ID;

        entry.innerHTML = `
            <div class="listItemBody actionsheetListItemBody">
                <div class="listItemBodyText actionSheetItemText">
                    Customs
                </div>
            </div>
        `;

        entry.addEventListener('pointerdown', event => {
            event.stopImmediatePropagation();
            prepareCustomsTransition(entry);
        }, true);

        entry.addEventListener('mousedown', event => {
            event.stopImmediatePropagation();
            prepareCustomsTransition(entry);
        }, true);

        entry.addEventListener('touchstart', event => {
            event.stopImmediatePropagation();
            prepareCustomsTransition(entry);
        }, true);

        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopImmediatePropagation();

            const context =
                pendingCustomsContext ||
                prepareCustomsTransition(entry);

            closeVanillaActionSheetLikeJellyfin().then(() => {
                openCustomsMenu(
                    context.rect,
                    context.originalCount
                );

                pendingCustomsContext = null;
            });
        }, true);

        return entry;
    }

    function injectCustomsMenuEntry() {
        ensureApi();
        ensureStyles();

        // Nothing to show if every addon is currently disabled (either by
        // its own admin toggle server-side, meaning its script was never
        // even delivered to the browser, or if none have registered yet
        // for any other reason). By the time this runs (triggered by the
        // user actually opening Jellyfin's own "..." menu, well after
        // player/page load), every currently-enabled addon has already
        // had its chance to call registerAddon(), so this is a reliable
        // check, not a race condition against addons that simply haven't
        // registered yet. Skips the whole entry point rather than showing
        // it and opening to an empty "No Customs installed" placeholder.
        if (window[API_NAME].getAddons().length === 0) {
            return false;
        }

        const statsButton = document.querySelector(
            '.actionSheetScroller .actionSheetMenuItem[data-id="stats"]'
        );

        if (!statsButton || !statsButton.parentNode) {
            return false;
        }

        const scroller = statsButton.parentNode;
        const sheet = statsButton.closest('.actionSheet');

        if (sheet?.classList.contains('jvosd-customs-popup')) {
            return false;
        }

        const originalTop =
            sheet
                ? parseFloat(sheet.style.top || sheet.getBoundingClientRect().top)
                : 0;

        const originalCount =
            scroller.querySelectorAll('.actionSheetMenuItem').length;

        if (!scroller.querySelector('.jvosd-customs-root-entry')) {
            statsButton.insertAdjacentElement(
                'afterend',
                createCustomsEntry()
            );
        }

        const newCount =
            scroller.querySelectorAll('.actionSheetMenuItem').length;

        if (sheet && !DONE.has(sheet)) {
            fitSheetToViewport(
                sheet,
                originalTop,
                originalCount,
                newCount
            );

            DONE.add(sheet);
        }

        return true;
    }

    ensureApi();

    const observer = new MutationObserver(() => {
        document
            .querySelectorAll('.focuscontainer.actionSheet:not(.jvosd-customs-popup)')
            .forEach(() => {
                injectCustomsMenuEntry();
            });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    injectCustomsMenuEntry();

    // ---- PLUGIN ADAPTER: apply fetched config once it arrives ----
    // Low time-pressure here compared to the other mods' own adapters:
    // the popup only ever renders once a user actively opens it (clicks
    // "Customs" in the settings menu), which in practice always happens
    // well after this async fetch has had time to resolve, no dual-mode
    // branch or awaited startup gating needed for this one.
    fetchPluginConfig().then(function (pluginConfig) {
        applyPluginConfig(pluginConfig);
    });
    // ---- END PLUGIN ADAPTER ----

})();