import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-performer-context-menu',
  templateUrl: './performer-context-menu.html',
  styleUrl: './performer-context-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:resize)': 'onViewportResize()',
  },
})
export class PerformerContextMenuComponent {
  private readonly viewportVersion = signal(0);
  private readonly menuElement = viewChild<ElementRef<HTMLDivElement>>('contextMenu');
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly actions = input.required<readonly ContextMenuAction[]>();
  readonly menuClosed = output<void>();
  readonly actionSelected = output<string>();
  readonly position = computed(() => {
    this.viewportVersion();

    if (typeof window === 'undefined') {
      return { left: this.x(), top: this.y() };
    }

    const viewportPadding = 8;
    const menu = this.menuElement()?.nativeElement;
    const menuWidth = menu?.offsetWidth ?? 176;
    const menuHeight = menu?.offsetHeight ?? 120;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
    const maxTop = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding);

    return {
      left: Math.min(Math.max(this.x(), viewportPadding), maxLeft),
      top: Math.min(Math.max(this.y(), viewportPadding), maxTop),
    };
  });

  constructor() {
    effect(() => {
      this.x();
      this.y();
      this.actions();
      this.menuElement();
      queueMicrotask(() => this.onViewportResize());
    });
  }

  onCloseMenu(): void {
    this.menuClosed.emit();
  }

  onActionSelected(actionId: string): void {
    this.actionSelected.emit(actionId);
  }

  onViewportResize(): void {
    this.viewportVersion.update((version) => version + 1);
  }
}

export interface ContextMenuAction {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
}
