//! A bounded map whose entries expire, for Twitch lookups every window asks
//! for again and again: profiles, sub status, follow dates. Lives in the
//! host so cards, which are new windows each time, share what the main
//! window already fetched.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct TtlCache<K, V> {
    ttl: Duration,
    cap: usize,
    map: Mutex<HashMap<K, (Instant, V)>>,
}

impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    pub fn new(ttl: Duration, cap: usize) -> Self {
        Self {
            ttl,
            cap,
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, key: &K) -> Option<V> {
        self.get_at(key, Instant::now())
    }

    pub fn insert(&self, key: K, value: V) {
        self.insert_at(key, value, Instant::now());
    }

    /// The cached value, or `fetch`'s on a miss. A failed fetch is not
    /// kept, so the next call tries again.
    pub async fn get_or_try_insert_with<E, F, Fut>(&self, key: K, fetch: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        if let Some(value) = self.get(&key) {
            return Ok(value);
        }
        let value = fetch().await?;
        self.insert(key, value.clone());
        Ok(value)
    }

    fn get_at(&self, key: &K, now: Instant) -> Option<V> {
        let map = self.map.lock().expect("ttl cache poisoned");
        map.get(key)
            .filter(|(at, _)| now.duration_since(*at) < self.ttl)
            .map(|(_, v)| v.clone())
    }

    fn insert_at(&self, key: K, value: V, now: Instant) {
        let mut map = self.map.lock().expect("ttl cache poisoned");
        if map.len() >= self.cap && !map.contains_key(&key) {
            map.retain(|_, (at, _)| now.duration_since(*at) < self.ttl);
            if map.len() >= self.cap {
                let oldest = map
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    map.remove(&k);
                }
            }
        }
        map.insert(key, (now, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_expire_after_the_ttl() {
        let cache = TtlCache::new(Duration::from_secs(60), 10);
        let t = Instant::now();
        cache.insert_at("a", 1, t);
        assert_eq!(cache.get_at(&"a", t + Duration::from_secs(59)), Some(1));
        assert_eq!(cache.get_at(&"a", t + Duration::from_secs(60)), None);
    }

    #[test]
    fn a_full_cache_drops_expired_entries_then_the_oldest() {
        let cache = TtlCache::new(Duration::from_secs(60), 2);
        let t = Instant::now();
        cache.insert_at("old", 1, t);
        cache.insert_at("mid", 2, t + Duration::from_secs(30));
        // "old" has expired by now, so it makes the room.
        cache.insert_at("new", 3, t + Duration::from_secs(61));
        assert_eq!(cache.get_at(&"mid", t + Duration::from_secs(62)), Some(2));
        assert_eq!(cache.get_at(&"new", t + Duration::from_secs(62)), Some(3));
        // Both still fresh, so the older one goes.
        cache.insert_at("newest", 4, t + Duration::from_secs(62));
        assert_eq!(cache.get_at(&"mid", t + Duration::from_secs(62)), None);
        assert_eq!(
            cache.get_at(&"newest", t + Duration::from_secs(62)),
            Some(4)
        );
    }

    #[tokio::test]
    async fn read_through_fetches_once_and_forgets_failures() {
        let cache = TtlCache::new(Duration::from_secs(60), 10);
        let failed: Result<u32, &str> = cache
            .get_or_try_insert_with("a", || async { Err("down") })
            .await;
        assert_eq!(failed, Err("down"));
        let got: Result<u32, &str> = cache.get_or_try_insert_with("a", || async { Ok(1) }).await;
        assert_eq!(got, Ok(1));
        let again: Result<u32, &str> = cache
            .get_or_try_insert_with("a", || async { panic!("served from the cache") })
            .await;
        assert_eq!(again, Ok(1));
    }

    #[test]
    fn replacing_a_key_keeps_the_others() {
        let cache = TtlCache::new(Duration::from_secs(60), 2);
        let t = Instant::now();
        cache.insert_at("a", 1, t);
        cache.insert_at("b", 2, t);
        cache.insert_at("a", 3, t);
        assert_eq!(cache.get_at(&"a", t), Some(3));
        assert_eq!(cache.get_at(&"b", t), Some(2));
    }
}
