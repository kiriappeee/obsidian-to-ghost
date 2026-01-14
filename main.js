"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
// Define the default settings
const DEFAULT_SETTINGS = {
    blogUrl: '',
    writingFolderPath: 'writing',
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
                try {
                    const secretKeys = await this.app.secretStorage.listSecrets();
                    console.log('Available secret keys:', secretKeys);
                    new obsidian_1.Notice('Secret keys logged to console.');
                }
                catch (e) {
                    console.error('Error listing secrets:', e);
                    new obsidian_1.Notice('Error listing secrets. See console for details.');
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
    }
}
//# sourceMappingURL=main.js.map