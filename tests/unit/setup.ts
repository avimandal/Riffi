import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';

if (typeof globalThis.DOMParser === 'undefined') {
  const { window } = new JSDOM('');
  globalThis.DOMParser = window.DOMParser;
  globalThis.XMLSerializer = window.XMLSerializer;
}
