"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
// Define the default settings
const DEFAULT_SETTINGS = {
    blogUrl: '',
    writingFolderPath: 'writing',
    ghostApiKeyName: 'ghost-admin-api-key', // Default for new setting
};
// ADDED: slugify function
function slugify(text) {
    return text
        .toString()
        .normalize('NFD') // split an accented letter in the base letter and the acent
        .replace(/[\u0300-\u036f]/g, '') // remove all previously split accents
        .toLowerCase()
        .trim() // Remove whitespace from both sides of a string
        .replace(/\s+/g, '-') // Replace spaces with -
        .replace(/[^\w\-]+/g, '') // Remove all non-word chars
        .replace(/\-\-+/g, '-'); // Replace multiple - with single -
}
class ObsidianToGhostPublisher extends obsidian_1.Plugin {
    settings;
    async onload() {
        console.log('loading Obsidian to Ghost Publisher plugin');
        // Load settings
        await this.loadSettings();
        // Add the settings tab
        this.addSettingTab(new GhostSettingsTab(this.app, this));
        // Add a command to publish to Ghost
        this.addCommand({
            id: 'publish-to-ghost',
            name: 'Publish to Ghost',
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) {
                    new obsidian_1.Notice('No active file to publish.');
                    return;
                }
                if (activeFile.extension !== 'md') {
                    new obsidian_1.Notice('Can only publish Markdown files.');
                    return;
                }
                try {
                    const fileContent = await this.app.vault.read(activeFile);
                    const parts = fileContent.split('---', 3); // Split into [before frontmatter, frontmatter, markdown]
                    let frontmatter = '';
                    let markdownContent = fileContent;
                    let title = activeFile.basename; // Default title to filename
                    if (parts.length >= 3) {
                        frontmatter = parts[1];
                        markdownContent = parts.slice(2).join('---').trim(); // Join back if there are more '---' in content
                        const titleMatch = frontmatter.match(/^title:\s*(.*)/m);
                        if (titleMatch && titleMatch[1]) {
                            // Remove quotes if present
                            title = titleMatch[1].replace(/^['"]|['"]$/g, '').trim();
                        }
                    }
                    else {
                        // No frontmatter found, whole file is markdown content
                        markdownContent = fileContent.trim();
                    }
                    // Generate slug
                    const slug = slugify(title);
                    const contentSnippet = markdownContent.substring(0, 100) + (markdownContent.length > 100 ? '...' : '');
                    new obsidian_1.Notice(`Title: "${title}"\nSlug: "${slug}"\nMarkdown: "${contentSnippet}"`, 15000);
                    console.log('Extracted Title:', title);
                    console.log('Generated Slug:', slug);
                    console.log('Extracted Markdown Content:', markdownContent);
                }
                catch (error) {
                    console.error('Error processing file:', error);
                    new obsidian_1.Notice('Error processing file. See console for details.', 10000);
                }
            },
        });
    }
    onunload() {
        console.log('unloading Obsidian to Ghost Publisher plugin');
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}
exports.default = ObsidianToGhostPublisher;
class GhostSettingsTab extends obsidian_1.PluginSettingTab {
    plugin;
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Ghost Publisher Settings' });
        new obsidian_1.Setting(containerEl)
            .setName('Blog URL')
            .setDesc('The public URL of your Ghost blog (e.g., https://myblog.com)')
            .addText(text => text
            .setPlaceholder('https://myblog.com')
            .setValue(this.plugin.settings.blogUrl)
            .onChange(async (value) => {
            this.plugin.settings.blogUrl = value;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName('Writing Folder Path')
            .setDesc('The path to the root folder containing your drafts and published posts.')
            .addText(text => text
            .setPlaceholder('writing')
            .setValue(this.plugin.settings.writingFolderPath)
            .onChange(async (value) => {
            this.plugin.settings.writingFolderPath = value;
            await this.plugin.saveSettings();
        }));
        // New Setting for Ghost Admin API Key Secret Name
        new obsidian_1.Setting(containerEl)
            .setName('Ghost Admin API Key Secret Name')
            .setDesc('The name of the secret stored in Obsidian\'s secure storage for your Ghost Admin API Key.')
            .addText(text => text
            .setPlaceholder(DEFAULT_SETTINGS.ghostApiKeyName)
            .setValue(this.plugin.settings.ghostApiKeyName)
            .onChange(async (value) => {
            this.plugin.settings.ghostApiKeyName = value;
            await this.plugin.saveSettings();
        }));
    }
}
//# sourceMappingURL=main.js.map