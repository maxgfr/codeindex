"""Core package logic for the mini repo."""
from .util import helper_fn
from pkg.util import helper_fn as _alias


def public_fn():
    return helper_fn()
