import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup } from '@angular/forms';
import { finalize } from 'rxjs';

import { PerformerDetailsSectionComponent } from './components/performer-details-section/performer-details-section';
import { PerformerFetchDialogComponent } from './components/performer-fetch-dialog/performer-fetch-dialog';
import { PerformerListSectionComponent } from './components/performer-list-section/performer-list-section';
import { PerformerLookupSectionComponent } from './components/performer-lookup-section/performer-lookup-section';
import { CatalogEntitySummary } from './models';
import { BraveSearchService } from './services/brave-search/brave-search.service';
import { PerformerLookupService } from './services/performers/performer-lookup.service';
import {
  DEBUG_LOGS_STORAGE_KEY,
  SessionFileAccessService,
} from './services/session-file-access/session-file-access.service';

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
  private readonly sessionFileAccess = inject(SessionFileAccessService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly maxDebugLogEntries = 250;
  private fileAccessBannerTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private awaitingFileAccessDecision = false;

  readonly performers = this.performerLookup.performers;
  readonly allPerformers = this.performerLookup.allPerformers;
  readonly selectedProfile = this.performerLookup.selectedProfile;
  readonly selectedPerformerId = this.performerLookup.selectedPerformerId;
  readonly addError = signal<string | undefined>(undefined);
  readonly missingPerformerCount = computed(
    () => this.allPerformers().filter((performer) => !performer.completed && !performer.noInfoFound).length,
  );
  readonly noInfoFoundCount = computed(
    () => this.allPerformers().filter((performer) => performer.noInfoFound).length,
  );
  readonly missingLookupInProgress = signal(false);
  readonly missingLookupDebugLogs = signal<readonly string[]>(this.readMissingLookupDebugLogs());
  readonly fetchDialogPerformer = signal<CatalogEntitySummary | undefined>(undefined);
  readonly fetchDialogError = signal<string | undefined>(undefined);
  readonly fetchDialogLoading = signal(false);
  readonly sessionFileAccessSupported = this.sessionFileAccess.supported;
  readonly sessionFileHandleStored = this.sessionFileAccess.hasStoredHandle;
  readonly sessionFileAccessState = this.sessionFileAccess.accessState;
  readonly sessionFileName = this.sessionFileAccess.fileName;
  readonly sessionFileAccessBusy = this.sessionFileAccess.busy;
  readonly showFileAccessBanner = signal(false);
  readonly fileAccessBannerState = signal<'prompt' | 'success'>('prompt');
  readonly selectedAge = computed(() => {
    const birthday = this.selectedProfile()?.birthday;

    return birthday ? calculateAge(birthday) : undefined;
  });

  readonly lookupForm = new FormGroup({
    search: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    const saveSessionOnPageExit = (reason: string): void => {
      this.sessionFileAccess.flushSessionToDisk(reason);
    };
    const saveSessionWhenHidden = (): void => {
      if (document.visibilityState !== 'hidden') {
        return;
      }

      saveSessionOnPageExit('document hidden');
    };
    const saveSessionOnPageHide = (): void => saveSessionOnPageExit('pagehide');
    const saveSessionBeforeUnload = (): void => saveSessionOnPageExit('beforeunload');

    this.lookupForm.controls.search.valueChanges.subscribe((value) =>
      this.performerLookup.updateSearchTerm(value),
    );

    effect(() => {
      const supported = this.sessionFileAccessSupported();
      const hasStoredHandle = this.sessionFileHandleStored();
      const accessState = this.sessionFileAccessState();
      const busy = this.sessionFileAccessBusy();

      if (!supported) {
        this.hideFileAccessBanner();
        return;
      }

      if (!this.awaitingFileAccessDecision || busy) {
        if (accessState === 'granted') {
          this.hideFileAccessBanner();
          return;
        }

        if (hasStoredHandle && accessState === 'prompt') {
          this.showPromptBanner();
          return;
        }

        if (!hasStoredHandle && accessState === 'not-configured') {
          this.showPromptBanner();
          return;
        }

        this.hideFileAccessBanner();
        return;
      }

      this.awaitingFileAccessDecision = false;

      if (accessState === 'granted') {
        this.showSuccessBanner();
        return;
      }

      this.hideFileAccessBanner();
    });

    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', saveSessionWhenHidden);
      window.removeEventListener('pagehide', saveSessionOnPageHide);
      window.removeEventListener('beforeunload', saveSessionBeforeUnload);

      if (this.fileAccessBannerTimeoutId) {
        clearTimeout(this.fileAccessBannerTimeoutId);
      }
    });

    document.addEventListener('visibilitychange', saveSessionWhenHidden);
    window.addEventListener('pagehide', saveSessionOnPageHide);
    window.addEventListener('beforeunload', saveSessionBeforeUnload);
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

  requestSessionFileAccess(): void {
    this.awaitingFileAccessDecision = true;
    void this.sessionFileAccess.requestAccess();
  }

  dismissSessionFileAccessBanner(): void {
    this.hideFileAccessBanner();
  }

  requestAutoUpdateForMissingPerformers(): void {
    if (this.missingLookupInProgress()) {
      this.appendMissingLookupLog('Lookup request ignored because a lookup is already in progress.');
      return;
    }

    const missingBefore = this.missingPerformerCount();
    this.appendMissingLookupLog(`Starting missing-info lookup for ${missingBefore} performer(s).`);
    this.missingLookupInProgress.set(true);
    this.performerLookup
      .lookupMissingPerformerInfo(this.allPerformers())
      .pipe(
        finalize(() => {
          this.missingLookupInProgress.set(false);
          this.appendMissingLookupLog(
            `Lookup complete. Missing: ${this.missingPerformerCount()}, No info found: ${this.noInfoFoundCount()}.`,
          );
        }),
      )
      .subscribe({
        next: (response) => {
          for (const logLine of response.debugLogs ?? []) {
            this.appendMissingLookupLog(logLine);
          }
          const summaries = response.summaries ?? [];
          this.appendMissingLookupLog(`Proxy returned ${summaries.length} updated performer record(s).`);
        },
        error: () => {
          this.appendMissingLookupLog('Lookup failed. Proxy unavailable or request error.');
          this.addError.set(
            'Unable to run missing-info search right now. Start the proxy with `npm run start:proxy` and try again.',
          );
        },
      });
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

    if (!performer || this.fetchDialogLoading()) {
      return;
    }

    this.appendMissingLookupLog(`Modal search started for "${performer.name}" (${performer.id}).`);
    this.fetchDialogLoading.set(true);
    this.fetchDialogError.set(undefined);
    this.performerLookup.lookupPerformerInfoWithoutLink(performer).subscribe({
      next: (response) => {
        for (const logLine of response.debugLogs ?? []) {
          this.appendMissingLookupLog(logLine);
        }
        const summaries = response.summaries ?? [];
        this.appendMissingLookupLog(
          `Modal search completed for "${performer.name}". Updated records: ${summaries.length}.`,
        );

        if (summaries.length === 0) {
          this.fetchDialogError.set(
            'Search finished but no profile updates were returned for this performer.',
          );
          this.fetchDialogLoading.set(false);
          return;
        }

        this.closeFetchDialog();
      },
      error: (error: unknown) => {
        this.appendMissingLookupLog(
          `Modal search failed for "${performer.name}".`,
        );
        const message =
          error instanceof Error
            ? error.message
            : 'Unable to run search without link right now.';
        this.fetchDialogError.set(message);
        this.fetchDialogLoading.set(false);
      },
    });
  }

  creditsOpen = signal(false);

  toggleCredits(): void {
    this.creditsOpen.update((open) => !open);
  }

  private appendMissingLookupLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${message}`;
    console.log(entry);
    this.missingLookupDebugLogs.update((logs) => {
      const nextLogs = [...logs, entry];
      const trimmedLogs = nextLogs.slice(-this.maxDebugLogEntries);
      sessionStorage.setItem(DEBUG_LOGS_STORAGE_KEY, JSON.stringify(trimmedLogs));
      this.sessionFileAccess.syncSessionToDisk();
      return trimmedLogs;
    });
  }

  private readMissingLookupDebugLogs(): readonly string[] {
    try {
      const raw = sessionStorage.getItem(DEBUG_LOGS_STORAGE_KEY);
      const logs = raw ? (JSON.parse(raw) as readonly unknown[]) : [];
      return logs
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(-this.maxDebugLogEntries);
    } catch {
      return [];
    }
  }

  private showPromptBanner(): void {
    if (this.fileAccessBannerTimeoutId) {
      clearTimeout(this.fileAccessBannerTimeoutId);
      this.fileAccessBannerTimeoutId = undefined;
    }

    this.fileAccessBannerState.set('prompt');
    this.showFileAccessBanner.set(true);
  }

  private showSuccessBanner(): void {
    this.fileAccessBannerState.set('success');
    this.showFileAccessBanner.set(true);

    if (this.fileAccessBannerTimeoutId) {
      clearTimeout(this.fileAccessBannerTimeoutId);
    }

    this.fileAccessBannerTimeoutId = setTimeout(() => {
      this.showFileAccessBanner.set(false);
      this.fileAccessBannerTimeoutId = undefined;
    }, 1500);
  }

  private hideFileAccessBanner(): void {
    if (this.fileAccessBannerTimeoutId) {
      clearTimeout(this.fileAccessBannerTimeoutId);
      this.fileAccessBannerTimeoutId = undefined;
    }

    this.awaitingFileAccessDecision = false;
    this.showFileAccessBanner.set(false);
    this.fileAccessBannerState.set('prompt');
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
