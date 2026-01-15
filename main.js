"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
// Define the default settings
const DEFAULT_SETTINGS = {
    blogUrl: '',
    writingFolderPath: 'writing',
    ghostApiKeyName: 'ghost-admin-api-key', // Default for new setting
};
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
                const blogUrl = this.settings.blogUrl;
                if (!blogUrl) {
                    new obsidian_1.Notice('Blog URL is not set in plugin settings.');
                    return;
                }
                // Handle trailing slash and construct URL
                const normalizedUrl = blogUrl.replace(/\/$/, '');
                const apiUrl = `${normalizedUrl}/ghost/api/admin/site/`;
                try {
                    new obsidian_1.Notice(`Fetching from ${apiUrl}...`);
                    const response = await (0, obsidian_1.request)({ url: apiUrl });
                    const siteData = JSON.parse(response);
                    // Display a summary of the site data
                    const noticeMessage = `Site Title: ${siteData.site.title}\nSite URL: ${siteData.site.url}`;
                    new obsidian_1.Notice(noticeMessage, 10000); // Show for 10 seconds
                    console.log('Ghost Site Data:', siteData);
                }
                catch (error) {
                    console.error('Error fetching Ghost site data:', error);
                    new obsidian_1.Notice('Error fetching Ghost site data. Is the Blog URL correct and is Ghost running?', 10000);
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