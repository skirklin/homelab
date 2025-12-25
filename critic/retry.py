"""
Retry utilities for handling API rate limits.

Implements exponential backoff with jitter for rate limit errors.
"""

import random
import time
from functools import wraps
from typing import Callable, TypeVar

import anthropic

T = TypeVar('T')


def with_retry(
    max_retries: int = 5,
    base_delay: float = 30.0,
    max_delay: float = 300.0,
    on_retry: Callable[[int, float, Exception], None] | None = None,
):
    """
    Decorator that adds retry with exponential backoff for rate limit errors.

    Args:
        max_retries: Maximum number of retry attempts
        base_delay: Initial delay in seconds (will be multiplied by 2^attempt)
        max_delay: Maximum delay between retries
        on_retry: Optional callback(attempt, delay, exception) called before each retry
    """
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> T:
            last_exception = None

            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except anthropic.RateLimitError as e:
                    last_exception = e

                    if attempt >= max_retries:
                        raise

                    # Calculate delay with exponential backoff and jitter
                    delay = min(base_delay * (2 ** attempt), max_delay)
                    jitter = random.uniform(0, delay * 0.1)  # 10% jitter
                    actual_delay = delay + jitter

                    if on_retry:
                        on_retry(attempt + 1, actual_delay, e)

                    time.sleep(actual_delay)

            # Should never reach here, but just in case
            if last_exception:
                raise last_exception
            raise RuntimeError("Unexpected retry loop exit")

        return wrapper
    return decorator


def retry_api_call(
    func: Callable[..., T],
    *args,
    max_retries: int = 5,
    base_delay: float = 30.0,
    max_delay: float = 300.0,
    on_retry: Callable[[int, float, Exception], None] | None = None,
    **kwargs,
) -> T:
    """
    Execute a function with retry logic for rate limit errors.

    Args:
        func: Function to execute
        *args: Positional arguments for func
        max_retries: Maximum number of retry attempts
        base_delay: Initial delay in seconds
        max_delay: Maximum delay between retries
        on_retry: Optional callback(attempt, delay, exception) called before each retry
        **kwargs: Keyword arguments for func

    Returns:
        The result of func(*args, **kwargs)

    Raises:
        anthropic.RateLimitError: If all retries are exhausted
    """
    last_exception = None

    for attempt in range(max_retries + 1):
        try:
            return func(*args, **kwargs)
        except anthropic.RateLimitError as e:
            last_exception = e

            if attempt >= max_retries:
                raise

            # Calculate delay with exponential backoff and jitter
            delay = min(base_delay * (2 ** attempt), max_delay)
            jitter = random.uniform(0, delay * 0.1)
            actual_delay = delay + jitter

            if on_retry:
                on_retry(attempt + 1, actual_delay, e)

            time.sleep(actual_delay)

    if last_exception:
        raise last_exception
    raise RuntimeError("Unexpected retry loop exit")


class RateLimitHandler:
    """
    Context manager for handling rate limits with automatic retry.

    Usage:
        with RateLimitHandler(on_retry=print_status) as handler:
            result = handler.execute(lambda: client.messages.create(...))
    """

    def __init__(
        self,
        max_retries: int = 5,
        base_delay: float = 30.0,
        max_delay: float = 300.0,
        on_retry: Callable[[int, float, Exception], None] | None = None,
    ):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.on_retry = on_retry
        self.total_wait_time = 0.0
        self.retry_count = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False

    def execute(self, func: Callable[..., T], *args, **kwargs) -> T:
        """Execute a function with retry logic."""
        return retry_api_call(
            func,
            *args,
            max_retries=self.max_retries,
            base_delay=self.base_delay,
            max_delay=self.max_delay,
            on_retry=self._track_retry,
            **kwargs,
        )

    def _track_retry(self, attempt: int, delay: float, exception: Exception):
        self.retry_count += 1
        self.total_wait_time += delay
        if self.on_retry:
            self.on_retry(attempt, delay, exception)
