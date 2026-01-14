import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';

// Define the settings interface
interface GhostPublisherSettings {
  blogUrl: string;
  writingFolderPath: string;
}

// Define the default settings
const DEFAULT_SETTINGS: GhostPublisherSettings = {
  blogUrl: '',
  writingFolderPath: 'writing',
};

export default class ObsidianToGhostPublisher extends Plugin {
  settings!: GhostPublisherSettings;

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
          new Notice('Secret keys logged to console.');
        } catch (e) {
          console.error('Error listing secrets:', e);
          new Notice('Error listing secrets. See console for details.');
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

class GhostSettingsTab extends PluginSettingTab {
  plugin: ObsidianToGhostPublisher;

  constructor(app: App, plugin: ObsidianToGhostPublisher) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Ghost Publisher Settings' });

    new Setting(containerEl)
      .setName('Blog URL')
      .setDesc('The public URL of your Ghost blog (e.g., https://myblog.com)')
      .addText(text => text
        .setPlaceholder('https://myblog.com')
        .setValue(this.plugin.settings.blogUrl)
        .onChange(async (value) => {
          this.plugin.settings.blogUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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
