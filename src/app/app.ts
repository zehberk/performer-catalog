import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup } from '@angular/forms';

import { PerformerDetailsSectionComponent } from './components/performer-details-section/performer-details-section';
import { PerformerFetchDialogComponent } from './components/performer-fetch-dialog/performer-fetch-dialog';
import { PerformerListSectionComponent } from './components/performer-list-section/performer-list-section';
import { PerformerLookupSectionComponent } from './components/performer-lookup-section/performer-lookup-section';
import { CatalogEntitySummary } from './models';
import { BraveSearchService } from './services/brave-search/brave-search.service';
import { PerformerLookupService } from './services/performers/performer-lookup.service';

@Component({
  selector: 'app-root',
  imports: [
    PerformerLookupSectionComponent,
    PerformerListSectionComponent,
    PerformerDetailsSectionComponent,
    PerformerFetchDialogComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly performerLookup = inject(PerformerLookupService);
  private readonly braveSearch = inject(BraveSearchService);

  readonly performers = this.performerLookup.performers;
  readonly selectedProfile = this.performerLookup.selectedProfile;
  readonly selectedPerformerId = this.performerLookup.selectedPerformerId;
  readonly addError = signal<string | undefined>(undefined);
  readonly fetchDialogPerformer = signal<CatalogEntitySummary | undefined>(undefined);
  readonly fetchDialogError = signal<string | undefined>(undefined);
  readonly fetchDialogLoading = signal(false);
  readonly selectedAge = computed(() => {
    const birthday = this.selectedProfile()?.birthday;

    return birthday ? calculateAge(birthday) : undefined;
  });

  readonly lookupForm = new FormGroup({
    search: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    this.lookupForm.controls.search.valueChanges.subscribe((value) =>
      this.performerLookup.updateSearchTerm(value),
    );
  }

  selectPerformer(summary: CatalogEntitySummary): void {
    this.performerLookup.selectPerformer(summary);
  }

  removePerformer(summary: CatalogEntitySummary): void {
    this.performerLookup.removePerformer(summary);
  }

  addPerformer(): void {
    const name = this.lookupForm.controls.search.value.trim();

    if (!name) {
      this.addError.set('Enter a performer name.');
      return;
    }

    this.performerLookup.addPerformer(name);
    this.lookupForm.reset({ search: '' });
    this.addError.set(undefined);
  }

  openFetchDialog(summary: CatalogEntitySummary): void {
    this.fetchDialogPerformer.set(summary);
    this.fetchDialogError.set(undefined);
    this.fetchDialogLoading.set(false);
  }

  closeFetchDialog(): void {
    this.fetchDialogPerformer.set(undefined);
    this.fetchDialogError.set(undefined);
    this.fetchDialogLoading.set(false);
  }

  fetchFromIafdLink(iafdUrl: string): void {
    const performer = this.fetchDialogPerformer();

    if (!performer || this.fetchDialogLoading()) {
      return;
    }

    this.fetchDialogLoading.set(true);
    this.fetchDialogError.set(undefined);
    this.performerLookup.fetchPerformerInfoFromIafd(performer, iafdUrl).subscribe({
      next: () => this.closeFetchDialog(),
      error: (error: unknown) => {
        if (isTransientRequestAbort(error)) {
          this.fetchDialogLoading.set(false);
          return;
        }

        const message =
          error instanceof Error ? error.message : 'Unable to fetch performer data right now.';
        this.fetchDialogError.set(message);
        this.fetchDialogLoading.set(false);
      },
    });
  }

  searchWithoutIafdLink(): void {
    const performer = this.fetchDialogPerformer();

    if (!performer) {
      return;
    }

    const searchUrl = this.braveSearch.createIafdSearchUrl(performer.name);
    window.open(searchUrl, '_blank', 'noopener');
  }

  creditsOpen = signal(false);

  toggleCredits(): void {
    this.creditsOpen.update((open) => !open);
  }
}

function calculateAge(birthday: string, today = new Date()): number | undefined {
  const birthDate = new Date(birthday);

  if (Number.isNaN(birthDate.getTime())) {
    return undefined;
  }

  let age = today.getFullYear() - birthDate.getFullYear();
  const hasHadBirthdayThisYear =
    today.getMonth() > birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate());

  if (!hasHadBirthdayThisYear) {
    age -= 1;
  }

  return age;
}

function isTransientRequestAbort(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse)) {
    return false;
  }

  const progressEvent = error.error;
  const eventType = progressEvent instanceof ProgressEvent ? progressEvent.type : undefined;

  if (eventType === 'abort') {
    return true;
  }

  if (error.status !== 0) {
    return false;
  }

  if (eventType === 'error') {
    return true;
  }

  return /unknown error/i.test(error.statusText);
}
