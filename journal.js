// ==UserScript==
// @name         Kindroid Journal Extractor
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Extract and display Kindroid journal entries in JSON format
// @author       You
// @match        https://kindroid.ai/v2/kin-settings/*/?tab=journal
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Main function to run the extraction process
    function extractJournalEntries() {
        console.log('Starting journal extraction...');
        
        // Find and click the Global button
        const globalButton = document.querySelector('button[role="radio"][aria-checked="false"] .segmented-control_label__36PcJ');
        if (globalButton) {
            const parentButton = globalButton.closest('button');
            if (parentButton) {
                parentButton.click();
                console.log('Clicked Global button');
            }
        } else {
            console.log('Global button not found, checking alternative selectors...');
            const altButton = document.querySelector('button.segmented-control_pill__mWax6.segmented-control_pill-full__HaSnn.segmented-control_pill-neutral__srEwm');
            if (altButton) {
                altButton.click();
                console.log('Clicked Global button (alternative selector)');
            }
        }

        // Wait a bit for the content to update
        setTimeout(() => {
            // Find all journal entries
            const entries = document.querySelectorAll('.journal-sheet-v2_entry-row-body__rnzsx.v2-selectable');
            console.log(`Found ${entries.length} journal entries`);
            
            const journalData = [];
            
            entries.forEach((entry, index) => {
                const titleElement = entry.querySelector('.journal-sheet-v2_entry-title__PgFaR');
                const descriptionElement = entry.querySelector('.journal-sheet-v2_entry-description__YcLQk');
                
                if (titleElement && descriptionElement) {
                    const title = titleElement.textContent.trim();
                    const description = descriptionElement.textContent.trim();
                    
                    // Extract keywords from title (split by commas)
                    const keywords = title.split(',').map(keyword => keyword.trim());
                    
                    journalData.push({
                        id: index + 1,
                        keywords: keywords,
                        mainEntry: description,
                        fullTitle: title
                    });
                }
            });
            
            // Create JSON object
            const result = {
                timestamp: new Date().toISOString(),
                totalEntries: journalData.length,
                entries: journalData
            };
            
            // Display the floating window with JSON data
            displayFloatingWindow(result);
            
            console.log('Journal extraction complete:', result);
            
        }, 1000); // 1 second delay for content to load
    }

    // Function to create and display floating window
    function displayFloatingWindow(data) {
        // Remove existing window if present
        const existingWindow = document.getElementById('journal-extractor-window');
        if (existingWindow) {
            existingWindow.remove();
        }

        // Create container
        const container = document.createElement('div');
        container.id = 'journal-extractor-window';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 500px;
            max-height: 80vh;
            background: #1a1a1a;
            color: #ffffff;
            border: 2px solid #4a4a4a;
            border-radius: 12px;
            padding: 20px;
            z-index: 99999;
            box-shadow: 0 8px 32px rgba(0,0,0,0.8);
            font-family: 'Courier New', monospace;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        `;

        // Header with title and close button
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid #4a4a4a;
        `;

        const title = document.createElement('h3');
        title.textContent = '📋 Journal JSON Data';
        title.style.cssText = `
            margin: 0;
            font-size: 16px;
            color: #00ff88;
        `;

        const closeButton = document.createElement('button');
        closeButton.textContent = '✕';
        closeButton.style.cssText = `
            background: none;
            border: none;
            color: #888;
            font-size: 20px;
            cursor: pointer;
            padding: 0 5px;
        `;
        closeButton.onmouseover = () => closeButton.style.color = '#ff4444';
        closeButton.onmouseout = () => closeButton.style.color = '#888';
        closeButton.onclick = () => container.remove();

        header.appendChild(title);
        header.appendChild(closeButton);
        container.appendChild(header);

        // Controls
        const controls = document.createElement('div');
        controls.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        `;

        // Copy button
        const copyButton = document.createElement('button');
        copyButton.textContent = '📋 Copy JSON';
        copyButton.style.cssText = `
            background: #2a2a2a;
            color: #ffffff;
            border: 1px solid #4a4a4a;
            border-radius: 6px;
            padding: 5px 12px;
            cursor: pointer;
            font-size: 12px;
        `;
        copyButton.onclick = () => {
            const jsonStr = JSON.stringify(data, null, 2);
            navigator.clipboard.writeText(jsonStr).then(() => {
                copyButton.textContent = '✅ Copied!';
                setTimeout(() => {
                    copyButton.textContent = '📋 Copy JSON';
                }, 2000);
            });
        };

        // Download button
        const downloadButton = document.createElement('button');
        downloadButton.textContent = '💾 Download JSON';
        downloadButton.style.cssText = `
            background: #2a2a2a;
            color: #ffffff;
            border: 1px solid #4a4a4a;
            border-radius: 6px;
            padding: 5px 12px;
            cursor: pointer;
            font-size: 12px;
        `;
        downloadButton.onclick = () => {
            const jsonStr = JSON.stringify(data, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `journal-entries-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };

        // Refresh button
        const refreshButton = document.createElement('button');
        refreshButton.textContent = '🔄 Refresh';
        refreshButton.style.cssText = `
            background: #2a2a2a;
            color: #ffffff;
            border: 1px solid #4a4a4a;
            border-radius: 6px;
            padding: 5px 12px;
            cursor: pointer;
            font-size: 12px;
        `;
        refreshButton.onclick = () => {
            container.remove();
            setTimeout(extractJournalEntries, 500);
        };

        controls.appendChild(copyButton);
        controls.appendChild(downloadButton);
        controls.appendChild(refreshButton);
        container.appendChild(controls);

        // JSON content area
        const contentArea = document.createElement('pre');
        contentArea.style.cssText = `
            flex: 1;
            overflow: auto;
            background: #0d0d0d;
            border-radius: 8px;
            padding: 15px;
            margin: 0;
            font-size: 12px;
            line-height: 1.6;
            max-height: 60vh;
            white-space: pre-wrap;
            word-wrap: break-word;
        `;
        
        const jsonString = JSON.stringify(data, null, 2);
        contentArea.textContent = jsonString;

        container.appendChild(contentArea);
        document.body.appendChild(container);

        // Make window draggable
        makeDraggable(container, header);
    }

    // Function to make the floating window draggable
    function makeDraggable(element, dragHandle) {
        let isDragging = false;
        let offsetX, offsetY;

        dragHandle.style.cursor = 'move';
        
        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = element.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            element.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const x = Math.max(0, Math.min(window.innerWidth - element.offsetWidth, e.clientX - offsetX));
            const y = Math.max(0, Math.min(window.innerHeight - element.offsetHeight, e.clientY - offsetY));
            element.style.left = x + 'px';
            element.style.top = y + 'px';
            element.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            element.style.cursor = 'default';
        });
    }

    // Wait for page to fully load and then run
    function initialize() {
        // Check if we're on the correct page
        if (window.location.href.includes('kindroid.ai/v2/kin-settings/') && 
            window.location.href.includes('tab=journal')) {
            // Wait a bit for the page to stabilize
            setTimeout(extractJournalEntries, 1500);
        }
    }

    // Run on page load
    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }

    // Also run when URL changes (for single-page app navigation)
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            if (url.includes('kindroid.ai/v2/kin-settings/') && url.includes('tab=journal')) {
                setTimeout(extractJournalEntries, 1500);
            }
        }
    }).observe(document, {subtree: true, childList: true});

})();