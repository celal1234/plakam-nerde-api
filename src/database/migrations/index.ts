import { InitialSchema1760947200000 } from './1760947200000-InitialSchema';
import { AuthTokens1760950800000 } from './1760950800000-AuthTokens';
import { ListingsFoundAtIstanbul1760954400000 } from './1760954400000-ListingsFoundAtIstanbul';
import { ListingLifecycle1760958000000 } from './1760958000000-ListingLifecycle';
import { AdminModeration1760961600000 } from './1760961600000-AdminModeration';

// Yeni migration'lar buraya sırayla eklenir; dosya taraması kullanılmaz.
export const migrations = [
  InitialSchema1760947200000,
  AuthTokens1760950800000,
  ListingsFoundAtIstanbul1760954400000,
  ListingLifecycle1760958000000,
  AdminModeration1760961600000,
];
