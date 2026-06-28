import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { App } from './app';
import { CatalogEntitySummary, PerformerProfile } from './models';
import { BraveSearchService } from './services/brave-search/brave-search.service';
import { PerformerLookupService } from './services/performers/performer-lookup.service';
import { SessionFileAccessService } from './services/session-file-access/session-file-access.service';

class PerformerLookupServiceStub {
  readonly performers = signal<readonly CatalogEntitySummary[]>([]);
  readonly allPerformers = signal<readonly CatalogEntitySummary[]>([]);
  readonly selectedProfile = signal<PerformerProfile | undefined>(undefined);
  readonly selectedPerformerId = signal<string | undefined>(undefined);

  updateSearchTerm(): void {}
  selectPerformer(): void {}
  removePerformer(): void {}
  addPerformer(): void {}
  lookupMissingPerformerInfo() {
    return of({ summaries: [], debugLogs: [] });
  }
  fetchPerformerInfoFromIafd() {
    return of(undefined);
  }
  lookupPerformerInfoWithoutLink() {
    return of({ summaries: [], debugLogs: [] });
  }
}

class BraveSearchServiceStub {}

class SessionFileAccessServiceStub {
  flushCount = 0;
  readonly supported = signal(false);
  readonly hasStoredHandle = signal(false);
  readonly accessState = signal<'unsupported' | 'not-configured' | 'prompt' | 'granted' | 'error'>(
    'unsupported',
  );
  readonly fileName = signal<string | undefined>(undefined);
  readonly lastSavedAt = signal<string | undefined>(undefined);
  readonly busy = signal(false);

  requestAccess(): Promise<void> {
    return Promise.resolve();
  }

  flushSessionToDisk(): void {
    this.flushCount += 1;
  }

  syncSessionToDisk(): void {}
}

describe('App', () => {
  let sessionFileAccess: SessionFileAccessServiceStub;

  beforeEach(async () => {
    sessionFileAccess = new SessionFileAccessServiceStub();

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: BraveSearchService, useClass: BraveSearchServiceStub },
        { provide: PerformerLookupService, useClass: PerformerLookupServiceStub },
        { provide: SessionFileAccessService, useValue: sessionFileAccess },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the performer lookup shell', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Performer Catalog');
    expect(compiled.querySelector('input[type="search"]')).toBeTruthy();
  });

  it('should flush the session backup when the page lifecycle is closing', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    expect(sessionFileAccess.flushCount).toBe(2);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sessionFileAccess.flushCount).toBe(3);
  });
});
