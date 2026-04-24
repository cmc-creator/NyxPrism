"""NyxPrism – Powerful AI-enhanced PDF multi-tool."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("nyxprism")
except PackageNotFoundError:  # running from source
    __version__ = "1.3.0"

__all__ = ["__version__"]
