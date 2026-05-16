import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-performer-context-menu',
  templateUrl: './performer-context-menu.html',
  styleUrl: './performer-context-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PerformerContextMenuComponent {
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly actions = input.required<readonly ContextMenuAction[]>();
  readonly menuClosed = output<void>();
  readonly actionSelected = output<string>();

  onCloseMenu(): void {
    this.menuClosed.emit();
  }

  onActionSelected(actionId: string): void {
    this.actionSelected.emit(actionId);
  }
}

export interface ContextMenuAction {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
}
