"""Password protection and encryption for PDF files."""
from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter


def protect(
    source: str | Path,
    user_password: str,
    owner_password: str | None = None,
    output: str | Path | None = None,
    permissions: int | None = None,
) -> Path:
    """Encrypt *source* with a user (read) and owner (full-access) password.

    Parameters
    ----------
    source:
        Input PDF path.
    user_password:
        Password required to open the document.
    owner_password:
        Password granting unrestricted access.  Defaults to the same as
        *user_password*.
    output:
        Output path.  Defaults to ``<stem>_protected.pdf``.
    permissions:
        Integer bitmask of allowed permissions (see pypdf docs).  ``None``
        uses the default (all permissions granted to the owner).

    Returns
    -------
    Path to the protected PDF.
    """
    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_protected.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    if owner_password is None:
        owner_password = user_password

    reader = PdfReader(str(source))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    writer.encrypt(
        user_password=user_password,
        owner_password=owner_password,
        use_128bit=True,
    )
    with open(output, "wb") as f:
        writer.write(f)
    return output


def unlock(
    source: str | Path,
    password: str,
    output: str | Path | None = None,
) -> Path:
    """Remove password protection from *source* (requires the correct password).

    Parameters
    ----------
    source:
        Input PDF path (must be encrypted).
    password:
        Password to decrypt the document.
    output:
        Output path.  Defaults to ``<stem>_unlocked.pdf``.

    Returns
    -------
    Path to the unlocked PDF.
    """
    source = Path(source)
    if output is None:
        output = source.parent / f"{source.stem}_unlocked.pdf"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(str(source))
    if reader.is_encrypted:
        result = reader.decrypt(password)
        if result == 0:
            raise ValueError("Incorrect password or unsupported encryption algorithm.")

    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    with open(output, "wb") as f:
        writer.write(f)
    return output
