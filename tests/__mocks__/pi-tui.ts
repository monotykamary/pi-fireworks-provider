// Minimal type stub for @earendil-works/pi-tui (a peer/ambient dependency provided
// by pi at runtime). Only declares the symbols the settings panel dynamically
// imports (SettingsList, Container). Used for editor/tsc support; the real
// package is loaded by pi when the extension runs.

export class Container {
  addChild(_child: any): void {}
  invalidate(): void {}
  render(_width: number): any {}
}

export interface SettingsListItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values: string[];
}

export class SettingsList {
  constructor(
    _items: SettingsListItem[],
    _height: number,
    _theme: any,
    _onChange: (id: string, newValue: string) => void,
    _onDone: () => void,
    _opts?: { enableSearch?: boolean },
  ) {}
  handleInput(_data: string): void {}
  invalidate(): void {}
  render(_width: number): any {}
}
