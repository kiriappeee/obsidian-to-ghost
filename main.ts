import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl, RequestUrlParam, TFile } from 'obsidian';

import { FormDataEncoder } from 'form-data-encoder';

// Define the settings interface
interface GhostPublisherSettings {
  blogUrl: string;
  writingFolderPath: string;
  ghostApiKeyName: string; // New setting
}

// Define the default settings
const DEFAULT_SETTINGS: GhostPublisherSettings = {
  blogUrl: '',
  writingFolderPath: 'writing',
  ghostApiKeyName: 'ghost-admin-api-key', // Default for new setting
};

// Helper: slugify function
function slugify(text: string): string {
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



import { sign } from 'jsonwebtoken';



import * as CryptoJS from 'crypto-js';

// Helper: JWT generation function
function generateGhostAdminToken(apiKey: string): string | null {
    const [id, secret] = apiKey.split(':');
    if (!id || !secret) {
        return null;
    }

    const header = {
        alg: 'HS256',
        typ: 'JWT',
        kid: id
    };

    const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (5 * 60),
        aud: '/admin/'
    };

    function base64url(source: any) {
        // Encode in classical base64
        let encodedSource = CryptoJS.enc.Base64.stringify(source);

        // Remove padding equal characters
        encodedSource = encodedSource.replace(/=+$/, '');

        // Replace characters according to base64url specifications
        encodedSource = encodedSource.replace(/\+/g, '-');
        encodedSource = encodedSource.replace(/\//g, '_');

        return encodedSource;
    }

    const encodedHeader = base64url(CryptoJS.enc.Utf8.parse(JSON.stringify(header)));
    const encodedPayload = base64url(CryptoJS.enc.Utf8.parse(JSON.stringify(payload)));

    const signature = CryptoJS.HmacSHA256(encodedHeader + '.' + encodedPayload, CryptoJS.enc.Hex.parse(secret));
    const encodedSignature = base64url(signature);

    return encodedHeader + '.' + encodedPayload + '.' + encodedSignature;
}

export default class ObsidianToGhostPublisher extends Plugin {
  settings!: GhostPublisherSettings;

  private getMimeType(extension: string): string {
    const mimeTypes: { [key: string]: string } = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
    };
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
  }

  private parseFrontmatterString(fmString: string, field: string): string | null {
    const regex = new RegExp(`^${field}:[ \\t]*(.*)`, 'm');
    const match = fmString.match(regex);
    return match ? match[1].replace(/^['"]|['"]$/g, '').trim() : null;
  }

  private async resolveInternalLinks(markdownContent: string, sourcePath: string): Promise<string> {
    // Regex to find WikiLinks that are NOT image links (negative lookbehind for '!')
    // Captures: 1=linkTarget (e.g., "My Note#Heading"), 2=displayText (if '|' present)
    const linkRegex = /(?<!\!)\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g;
    let processedMarkdown = markdownContent;
    const matches = Array.from(markdownContent.matchAll(linkRegex));

    if (matches.length > 0) {
      new Notice(`Found ${matches.length} internal link(s) to resolve...`);
    }

    for (const match of matches) {
      const fullLinkMatch = match[0]; // e.g., "[[My Note#Heading|Display Text]]"
      const linkTargetWithAnchor = match[1]; // e.g., "My Note#Heading"
      const customDisplayText = match[2]; // e.g., "Display Text"

      const [linkPath, anchor] = linkTargetWithAnchor.split('#'); // linkPath: "My Note", anchor: "Heading"
      const linkTargetFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);

      if (!linkTargetFile) {
        throw new Error(`Could not resolve internal link: [[${linkTargetWithAnchor}]]`);
      }

      const targetContent = await this.app.vault.read(linkTargetFile);
      const targetParts = targetContent.split('---', 3);

      if (targetParts.length < 3) {
        throw new Error(`Cannot publish: Linked post '${linkPath}' is not published (missing frontmatter).`);
      }

      const targetFrontmatter = targetParts[1];
      const publishedUrl = this.parseFrontmatterString(targetFrontmatter, 'publishedUrl');

      if (!publishedUrl) {
        throw new Error(`Cannot publish: Linked post '${linkPath}' is not published (missing 'publishedUrl').`);
      }

      let finalUrl = publishedUrl;
      if (anchor) {
        finalUrl += `#${slugify(anchor)}`;
      }

      const linkText = customDisplayText || linkPath; // Use custom text or just the linkPath (file name)

      processedMarkdown = processedMarkdown.replace(fullLinkMatch, `[${linkText}](${finalUrl})`);
    }

    return processedMarkdown;
  }

  private async uploadAndReplaceImages(markdownContent: string, token: string, sourcePath: string): Promise<string> {
    const imageRegex = /!\[(?:\[([^\]]*)\])?\(([^)]+)\)|!\[\[([^\]]+)\]\]/g;
    let processedMarkdown = markdownContent;
    const matches = Array.from(markdownContent.matchAll(imageRegex));

    if (matches.length > 0) {
      new Notice(`Found ${matches.length} image(s) to upload...`);
    }

    for (const match of matches) {
      const isWikiLink = match[3] !== undefined;
      const localSrc = isWikiLink ? match[3] : match[2];
      const altText = isWikiLink ? '' : match[1] || '';

      const imageFile = this.app.metadataCache.getFirstLinkpathDest(localSrc, sourcePath);
      if (!imageFile) {
        throw new Error(`Image not found in vault: ${localSrc}`);
      }

      const imageData = await this.app.vault.readBinary(imageFile);
      const mimeType = this.getMimeType(imageFile.extension);
      
      const formData = new FormData();
      formData.append('file', new Blob([imageData], { type: mimeType }), imageFile.name);
      formData.append('ref', imageFile.path);
      formData.append('purpose', 'image');

      const encoder = new FormDataEncoder(formData);
      
      const chunks: Uint8Array[] = [];
      for await (const chunk of encoder) {
        chunks.push(chunk);
      }
      
      // Concatenate Uint8Array chunks
      let totalLength = 0;
      for (const chunk of chunks) {
        totalLength += chunk.length;
      }
      const concatenated = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.length;
      }
      
      const normalizedUrl = this.settings.blogUrl.replace(/\/$/, '');
      const uploadUrl = `${normalizedUrl}/ghost/api/admin/images/upload/`;

      const requestParams: RequestUrlParam = {
        url: uploadUrl,
        method: 'POST',
        headers: {
          'Authorization': `Ghost ${token}`,
          'Content-Type': encoder.headers['Content-Type'],
        },
        body: concatenated.buffer,
        throw: false
      };

      const response = await requestUrl(requestParams);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Image upload failed for ${localSrc}: Status ${response.status} - ${response.text}`);
      }
      
      const uploadedImageData = response.json;
      const remoteUrl = uploadedImageData.images[0].url;

      processedMarkdown = processedMarkdown.replace(match[0], `![${altText}](${remoteUrl})`);
    }
    return processedMarkdown;
  }

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
        // --- 1. Get active file and extract content ---
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active file to publish.');
          return;
        }
        if (activeFile.extension !== 'md') {
          new Notice('Can only publish Markdown files.');
          return;
        }

        try {
          const fileContent = await this.app.vault.read(activeFile);
          const parts = fileContent.split('---', 3);

          let frontmatter = '';
          let markdownContent = fileContent;
          let title = activeFile.basename;
          let ghostTagsString: string | null = null; // Declare here
          let ghostExcerptString: string | null = null; // Declare here
          let ghostPostId: string | null = null; // To check if updating

          if (parts.length >= 3) {
            frontmatter = parts[1];
            markdownContent = parts.slice(2).join('---').trim();
            title = this.parseFrontmatterString(frontmatter, 'title') || activeFile.basename;
            ghostTagsString = this.parseFrontmatterString(frontmatter, 'ghostTags'); // Extract tags
            ghostExcerptString = this.parseFrontmatterString(frontmatter, 'ghostExcerpt'); // Extract excerpt
            ghostPostId = this.parseFrontmatterString(frontmatter, 'ghostPostId'); // Check for ID
          } else {
            markdownContent = fileContent.trim();
          }

          // --- 2. Get Settings and API Key ---
          const { blogUrl, ghostApiKeyName } = this.settings;
          if (!blogUrl || !ghostApiKeyName) {
            new Notice('Blog URL and API Key Name must be set in settings.');
            return;
          }

          const apiKey = await this.app.secretStorage.getSecret(ghostApiKeyName);
          if (!apiKey) {
            new Notice(`API Key secret named '${ghostApiKeyName}' not found.`);
            return;
          }

          // --- 3. Generate JWT ---
          const token = generateGhostAdminToken(apiKey);
          if (!token) {
            new Notice('API Key is not in the correct format (id:secret).');
            return;
          }
          
          // --- 4. Process Content (Compiler) ---
          const markdownWithImages = await this.uploadAndReplaceImages(markdownContent, token, activeFile.path);
          const finalMarkdown = await this.resolveInternalLinks(markdownWithImages, activeFile.path);

          // --- 5. Generate Slug ---
          const slug = slugify(title);

          // --- 6. Process Tags ---
          const processedTags = ghostTagsString
            ? ghostTagsString.split(',').map(tag => ({ name: tag.trim() })).filter(tag => tag.name.length > 0)
            : [];
          
          // --- 7. Construct Lexical Payload ---
          // NOTE: Ghost 5.x uses Lexical as the editor. While Mobiledoc is supported for backward compatibility,
          // if a post has been edited in Ghost's new editor, it expects 'lexical' field updates.

          const lexicalPayload = {
            root: {
              children: [
                {
                  type: "markdown",
                  version: 1,
                  markdown: finalMarkdown
                }
              ],
              direction: null,
              format: "",
              indent: 0,
              type: "root",
              version: 1
            }
          };

          const normalizedUrl = blogUrl.replace(/\/$/, '');

          let responseData;
          let newPost;

          if (ghostPostId) {
            // --- UPDATE PATH ---
            new Notice(`Updating post "${title}"...`);

            // Fetch the existing post to get updated_at
            const fetchUrl = `${normalizedUrl}/ghost/api/admin/posts/${ghostPostId}/`;
             const fetchParams: RequestUrlParam = {
                url: fetchUrl,
                method: 'GET',
                headers: {
                  'Authorization': `Ghost ${token}`,
                  'Content-Type': 'application/json'
                },
                throw: false
            };

            const fetchResponse = await requestUrl(fetchParams);

            if (fetchResponse.status === 404) {
                 throw new Error('Post not found on Ghost. Please check if it was deleted.');
            }
             if (fetchResponse.status < 200 || fetchResponse.status >= 300) {
                throw new Error(`Failed to fetch post for update: Status ${fetchResponse.status} - ${fetchResponse.text}`);
            }

            // const currentPost = fetchResponse.json.posts[0];
            // const updatedAt = currentPost.updated_at;
            const updatedAt = new Date().toISOString();

            const updatePayload: any = {
                posts: [{
                    title: title,
                    slug: slug,
                    status: 'published',
                    lexical: JSON.stringify(lexicalPayload),
                    updated_at: updatedAt // Required for optimistic locking
                }]
            };

            if (processedTags.length > 0) {
                updatePayload.posts[0].tags = processedTags;
            }
            if (ghostExcerptString) {
                updatePayload.posts[0].custom_excerpt = ghostExcerptString;
            }

            console.log('Sending update payload:', updatePayload);

             const updateParams: RequestUrlParam = {
                url: fetchUrl, // PUT to the same ID URL
                method: 'PUT',
                headers: {
                  'Authorization': `Ghost ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(updatePayload),
                throw: false
            };

            const updateResponse = await requestUrl(updateParams);

             if (updateResponse.status < 200 || updateResponse.status >= 300) {
                throw new Error(`Post update failed: Status ${updateResponse.status} - ${updateResponse.text}`);
            }

            responseData = updateResponse.json;
            newPost = responseData.posts[0];
             new Notice(`Updated "${newPost.title}"! URL: ${newPost.url}`, 5000);

          } else {
            // --- CREATE PATH ---
            new Notice(`Attempting to publish "${title}"...`);
            const apiUrl = `${normalizedUrl}/ghost/api/admin/posts/`;

            const postPayload: any = { // Use any for dynamic properties
                posts: [{
                title: title,
                slug: slug,
                status: 'published',
                lexical: JSON.stringify(lexicalPayload)
                }]
            };

            if (processedTags.length > 0) {
                postPayload.posts[0].tags = processedTags;
            }
            if (ghostExcerptString) {
                postPayload.posts[0].custom_excerpt = ghostExcerptString;
            }

            console.log('Sending post payload:', postPayload);

            const postRequestParams: RequestUrlParam = {
                url: apiUrl,
                method: 'POST',
                headers: {
                'Content-Type': 'application/json',
                'Authorization': `Ghost ${token}`
                },
                body: JSON.stringify(postPayload),
                throw: false
            };

            const response = await requestUrl(postRequestParams);

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Post creation failed: Status ${response.status} - ${response.text}`);
            }

            responseData = response.json;
            newPost = responseData.posts[0];
            new Notice(`Published "${newPost.title}"! ID: ${newPost.id}, URL: ${newPost.url}`, 15000);
          }
          
          console.log('Successfully processed post:', newPost);

          // --- 8. Update Frontmatter in Obsidian ---
          const currentDate = new Date().toISOString().split('T')[0];
          let updatedFrontmatter = frontmatter;

          const updateFrontmatterField = (fmString: string, field: string, value: string): string => {
            const regex = new RegExp(`^${field}:.*`, 'm');
            const newValueLine = `${field}: ${value}`;
            
            const trimmedFm = fmString.trim();
            if (trimmedFm === '') {
              return newValueLine + '\n';
            }

            if (fmString.match(regex)) {
              return fmString.replace(regex, newValueLine);
            } else {
              if (fmString.endsWith('\n')) {
                  return fmString + newValueLine + '\n';
              } else {
                  return fmString + '\n' + newValueLine + '\n';
              }
            }
          };
          
          updatedFrontmatter = updateFrontmatterField(updatedFrontmatter, 'ghostPostId', newPost.id);
          updatedFrontmatter = updateFrontmatterField(updatedFrontmatter, 'publishedUrl', newPost.url);
          // Only add publishedDate if it was a creation event or if it's missing (though logic here updates it if we want, I'll stick to updating it only if creating)
          if (!ghostPostId) {
             updatedFrontmatter = updateFrontmatterField(updatedFrontmatter, 'publishedDate', currentDate);
          } else {
              // If it's an update, we might want to ensure publishedDate exists, but let's leave it unless missing.
              // Actually, user didn't specify, but safer to not overwrite original published date.
              // If it's missing in frontmatter, maybe add it?
              // Let's simpler: just add it if not present? The regex `^${field}:.*` handles replacement.
              // If I don't call updateFrontmatterField for 'publishedDate', it won't be touched.
              // But for safety, I'll only add it if I'm creating.
          }

          
          let updatedFileContent = `---\n${updatedFrontmatter}---\n${markdownContent}`;
          if (parts.length < 3) {
             // If there was no frontmatter, we create it. This is definitely a creation event (since we need ghostPostId for update).
            updatedFileContent = `---\ntitle: ${title}\nghostPostId: ${newPost.id}\npublishedUrl: ${newPost.url}\npublishedDate: ${currentDate}\n---\n${fileContent}`;
          }

          await this.app.vault.modify(activeFile, updatedFileContent);
          new Notice('Frontmatter updated.', 4000);
          console.log('Frontmatter updated.');

          // --- 9. Move File to Published Folder ---
          const writingFolderPath = this.settings.writingFolderPath;
          const publishedFolderPath = `${writingFolderPath}/Published`;
          
          // Check if file is already in the published folder
          if (!activeFile.path.startsWith(`${publishedFolderPath}/`)) {
              try {
                await this.app.vault.createFolder(publishedFolderPath);
              } catch (e) {
                // Folder already exists, which is fine.
              }

              const newFilePath = `${publishedFolderPath}/${activeFile.name}`;
              // Check if a file with the same name already exists in destination
              // If so, we might fail or overwrite? Rename throws if exists.
              // Since we might be updating a file that WAS elsewhere, but we don't want to overwrite another file.
              // For now, assume it's fine or user manages it.

              await this.app.vault.rename(activeFile, newFilePath);
              new Notice(`File moved to "${publishedFolderPath}"`, 5000);
              console.log(`File moved to ${newFilePath}`);
          } else {
              console.log('File is already in Published folder. Skipping move.');
          }


        } catch (error) {
          console.error('--- DETAILED PUBLISH ERROR ---');
          console.error('Error Object:', error);
          
          let detailedMessage = 'An unknown error occurred.';
          
          if (error && typeof error === 'object') {
            try {
              console.error('Error stringified:', JSON.stringify(error, null, 2));
              detailedMessage = (error as any).message || JSON.stringify(error);
            } catch (e) {
              console.error('Could not stringify the error object:', e);
              detailedMessage = 'An un-stringifiable error object was thrown. Check the "Error Object" log above.';
            }
          } else {
            detailedMessage = String(error);
          }
          
          console.error('--- END DETAILED ERROR ---');
          new Notice(`Error: ${detailedMessage.substring(0, 150)}. Check developer console for full details.`, 15000);
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

    // New Setting for Ghost Admin API Key Secret Name
    new Setting(containerEl)
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
