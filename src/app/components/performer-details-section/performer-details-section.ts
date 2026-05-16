import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { PerformerProfile } from '../../models';

@Component({
  selector: 'app-performer-details-section',
  templateUrl: './performer-details-section.html',
  styleUrl: './performer-details-section.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PerformerDetailsSectionComponent {
  readonly profile = input<PerformerProfile | undefined>(undefined);
  readonly selectedAge = input<number | undefined>(undefined);
  readonly creditsOpen = input<boolean>(false);
  readonly toggleCredits = output<void>();

  readonly credits = computed(() => this.profile()?.credits ?? []);

  onToggleCredits(): void {
    this.toggleCredits.emit();
  }

  getFaviconUrl(url: string): string {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch {
      return '';
    }
  }
}
