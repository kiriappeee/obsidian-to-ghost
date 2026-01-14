import 'obsidian';

declare module 'obsidian' {
    interface SecretStorage {
        getSecret(key: string): Promise<string | null>;
    }
}
